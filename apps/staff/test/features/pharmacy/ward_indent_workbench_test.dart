import 'dart:async';

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
import 'package:vhhealth_staff/features/pharmacy/widgets/ward_indent_request_sheet.dart';

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

  for (final failOlderRequest in [false, true]) {
    testWidgets(
      'late row detail ${failOlderRequest ? 'failure' : 'success'} cannot replace a newer deep link',
      (tester) async {
        final older = _indent(id: 73, number: 'WARD-73');
        final newer = _indent(id: 74, number: 'WARD-74');
        final pending = Completer<WardIndent>();
        final gateway = _FakeWardIndentGateway(
          listRows: [older, newer],
          initialDetail: older,
          detailLoader: (id) =>
              id == older.id ? pending.future : Future.value(newer),
        );

        await _pumpWorkbench(
          tester,
          gateway: gateway,
          rawRole: 'PHARMACY_STAFF',
        );
        await tester.tap(find.byKey(const Key('ward-indent-row-73')));
        await tester.pump();
        expect(gateway.getIds, [73]);
        final state = tester.state(find.byType(WardIndentWorkbench));
        await _pumpWorkbench(
          tester,
          gateway: gateway,
          rawRole: 'PHARMACY_STAFF',
          initialIndentId: 74,
          settle: false,
        );
        await tester.pump();
        expect(tester.state(find.byType(WardIndentWorkbench)), same(state));
        expect(gateway.getIds, [73, 74]);
        expect(find.byKey(const Key('ward-indent-detail-74')), findsOneWidget);

        if (failOlderRequest) {
          pending.completeError(Exception('older detail failed'));
        } else {
          pending.complete(older);
        }
        await tester.pumpAndSettle();

        expect(find.byKey(const Key('ward-indent-detail-74')), findsOneWidget);
        expect(find.byKey(const Key('ward-indent-detail-73')), findsNothing);
        expect(find.byKey(const Key('ward-indent-action-error')), findsNothing);
        expect(gateway.mutateCalls, 0);
      },
    );

    testWidgets(
      'late refresh ${failOlderRequest ? 'failure' : 'success'} cannot affect a newer deep link',
      (tester) async {
        final older = _indent(id: 73, number: 'WARD-73');
        final newer = _indent(id: 74, number: 'WARD-74');
        final pending = Completer<WardIndent>();
        var olderReads = 0;
        final gateway = _FakeWardIndentGateway(
          listRows: [older, newer],
          initialDetail: older,
          detailLoader: (id) {
            if (id == newer.id) return Future.value(newer);
            olderReads += 1;
            return olderReads == 1 ? Future.value(older) : pending.future;
          },
        );

        await _pumpWorkbench(
          tester,
          gateway: gateway,
          rawRole: 'PHARMACY_STAFF',
          initialIndentId: 73,
        );
        final refresh = tester.widget<RefreshIndicator>(
          find.ancestor(
            of: find.byKey(const Key('ward-indent-detail-73')),
            matching: find.byType(RefreshIndicator),
          ),
        );
        final refreshResult = expectLater(refresh.onRefresh(), completes);
        expect(gateway.getIds, [73, 73]);
        final state = tester.state(find.byType(WardIndentWorkbench));
        await _pumpWorkbench(
          tester,
          gateway: gateway,
          rawRole: 'PHARMACY_STAFF',
          initialIndentId: 74,
        );
        expect(tester.state(find.byType(WardIndentWorkbench)), same(state));
        expect(gateway.getIds, [73, 73, 74]);

        if (failOlderRequest) {
          pending.completeError(Exception('older refresh failed'));
        } else {
          pending.complete(older);
        }
        await refreshResult;
        await tester.pumpAndSettle();

        expect(find.byKey(const Key('ward-indent-detail-74')), findsOneWidget);
        expect(find.byKey(const Key('ward-indent-detail-73')), findsNothing);
        expect(find.byKey(const Key('ward-indent-action-error')), findsNothing);
        expect(gateway.mutateCalls, 0);
      },
    );
  }

  testWidgets(
    'confirmation for an older selection cannot mutate a newer indent',
    (tester) async {
      final older = _indent(id: 73, number: 'WARD-73', status: 'reserved');
      final newer = _indent(id: 74, number: 'WARD-74', status: 'reserved');
      final gateway = _FakeWardIndentGateway(
        listRows: [older, newer],
        initialDetail: older,
        detailLoader: (id) => Future.value(id == older.id ? older : newer),
      );

      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'PHARMACY_INCHARGE',
        initialIndentId: 73,
      );
      final approve = find.byKey(const Key('ward-indent-action-approve'));
      await tester.ensureVisible(approve);
      await tester.tap(approve);
      await tester.pumpAndSettle();
      expect(find.text('Confirm'), findsOneWidget);
      final state = tester.state(
        find.byType(WardIndentWorkbench, skipOffstage: false),
      );
      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'PHARMACY_INCHARGE',
        initialIndentId: 74,
      );
      expect(
        tester.state(find.byType(WardIndentWorkbench, skipOffstage: false)),
        same(state),
      );
      expect(gateway.getIds, [73, 74]);
      expect(
        find.byKey(const Key('ward-indent-detail-74'), skipOffstage: false),
        findsOneWidget,
      );
      expect(find.text('Confirm'), findsOneWidget);
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();

      expect(gateway.mutateCalls, 0);
      expect(find.byKey(const Key('ward-indent-detail-74')), findsOneWidget);
    },
  );

  for (final change in [
    'round-trip',
    'role',
    'typed-role',
    'gateway',
    'version',
  ]) {
    testWidgets('pending confirmation is cancelled by $change context change', (
      tester,
    ) async {
      final initial = _indent(id: 73, number: 'WARD-73', status: 'reserved');
      final other = _indent(id: 74, number: 'WARD-74', status: 'reserved');
      final refreshed = _indent(
        id: 73,
        number: 'WARD-73',
        status: 'reserved',
        version: 2,
      );
      var reads = 0;
      final gateway = _FakeWardIndentGateway(
        listRows: [initial, other],
        initialDetail: initial,
        detailLoader: (id) {
          reads += 1;
          return Future.value(
            id == 74
                ? other
                : change == 'version' && reads > 1
                ? refreshed
                : initial,
          );
        },
      );
      final replacement = _FakeWardIndentGateway(
        listRows: [initial],
        initialDetail: initial,
      );
      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'PHARMACY_INCHARGE',
        initialIndentId: 73,
      );
      await tester.ensureVisible(
        find.byKey(const Key('ward-indent-action-approve')),
      );
      await tester.tap(find.byKey(const Key('ward-indent-action-approve')));
      await tester.pumpAndSettle();
      final state = tester.state(
        find.byType(WardIndentWorkbench, skipOffstage: false),
      );
      if (change == 'version') {
        await _detailRefresh(tester, 73)();
        await tester.pump();
        expect(find.text('v2', skipOffstage: false), findsOneWidget);
      } else {
        await _pumpWorkbench(
          tester,
          gateway: change == 'gateway' ? replacement : gateway,
          rawRole: change == 'role' ? 'ADMISSION_OFFICER' : 'PHARMACY_INCHARGE',
          role: change == 'typed-role'
              ? StaffRole.fromString('ADMISSION_OFFICER')
              : null,
          initialIndentId: change == 'round-trip' ? 74 : 73,
        );
        if (change == 'round-trip') {
          await _pumpWorkbench(
            tester,
            gateway: gateway,
            rawRole: 'PHARMACY_INCHARGE',
            initialIndentId: 73,
          );
          expect(gateway.getIds, [73, 74, 73]);
        }
      }
      expect(
        tester.state(find.byType(WardIndentWorkbench, skipOffstage: false)),
        same(state),
      );
      expect(find.text('Confirm'), findsOneWidget);
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();
      expect(gateway.mutateCalls, 0);
      expect(replacement.mutateCalls, 0);
    });
  }

  for (final change in ['role', 'typed-role', 'gateway', 'requester-gateway']) {
    for (final failingRead in ['list', 'detail']) {
      testWidgets(
        'failed $failingRead after $change change cannot expose or mutate the old selection',
        (tester) async {
          final initial = _indent(
            id: 73,
            number: 'WARD-73',
            status: 'reserved',
          );
          var changed = false;
          Future<WardIndentPage> loadList() async {
            if (changed && failingRead == 'list') {
              throw Exception('new context list failed');
            }
            return WardIndentPage(items: [initial], hasMore: false);
          }

          Future<WardIndent> loadDetail(int id) async {
            if (changed && failingRead == 'detail') {
              throw Exception('new context detail failed');
            }
            return initial;
          }

          final gateway = _FakeWardIndentGateway(
            listRows: [initial],
            initialDetail: initial,
            listLoader: loadList,
            detailLoader: loadDetail,
          );
          final replacement = _FakeWardIndentGateway(
            listRows: [initial],
            initialDetail: initial,
            listLoader: loadList,
            detailLoader: loadDetail,
          );
          await _pumpWorkbench(
            tester,
            gateway: gateway,
            rawRole: 'PHARMACY_STAFF',
            initialIndentId: 73,
          );
          final state = tester.state(find.byType(WardIndentWorkbench));
          final oldAction = tester
              .widget<FilledButton>(
                find.byKey(const Key('ward-indent-action-approve')),
              )
              .onPressed!;
          changed = true;
          await _pumpWorkbench(
            tester,
            gateway: change == 'gateway' ? replacement : gateway,
            rawRole: change == 'role' ? 'ADMISSION_OFFICER' : 'PHARMACY_STAFF',
            role: change == 'typed-role'
                ? StaffRole.fromString('ADMISSION_OFFICER')
                : null,
            requesterGateway: change == 'requester-gateway'
                ? const ApiWardIndentGateway()
                : null,
            initialIndentId: 73,
          );
          expect(tester.state(find.byType(WardIndentWorkbench)), same(state));
          expect(
            find.textContaining('new context $failingRead failed'),
            findsOneWidget,
          );
          expect(find.byKey(const Key('ward-indent-detail-73')), findsNothing);
          expect(find.byKey(const Key('ward-indent-row-73')), findsNothing);
          expect(
            find.byKey(const Key('ward-indent-action-approve')),
            findsNothing,
          );
          final activeGateway = change == 'gateway' ? replacement : gateway;
          expect(
            activeGateway.listRequests.length,
            change == 'gateway' ? 1 : 2,
          );
          expect(
            activeGateway.getIds,
            change == 'gateway'
                ? (failingRead == 'detail' ? [73] : <int>[])
                : (failingRead == 'detail' ? [73, 73] : [73]),
          );
          oldAction();
          await tester.pumpAndSettle();
          expect(find.text('Confirm'), findsNothing);
          expect(gateway.mutateCalls, 0);
          expect(replacement.mutateCalls, 0);
        },
      );
    }
  }

  testWidgets(
    'authority reload preserves the selected target when no initial deep link is supplied',
    (tester) async {
      final initial = _indent(id: 73, number: 'WARD-73');
      final gateway = _FakeWardIndentGateway(
        listRows: [initial],
        initialDetail: initial,
      );
      final replacement = _FakeWardIndentGateway(
        listRows: [initial],
        initialDetail: initial,
      );
      await _pumpWorkbench(tester, gateway: gateway, rawRole: 'PHARMACY_STAFF');
      await tester.tap(find.byKey(const Key('ward-indent-row-73')));
      await tester.pumpAndSettle();
      await _pumpWorkbench(
        tester,
        gateway: replacement,
        rawRole: 'PHARMACY_STAFF',
      );
      expect(replacement.getIds, [73]);
      expect(find.byKey(const Key('ward-indent-detail-73')), findsOneWidget);
    },
  );

  for (final failingRead in ['list', 'detail']) {
    testWidgets(
      'failed new deep-link $failingRead does not retain the old detail',
      (tester) async {
        final initial = _indent(id: 73, number: 'WARD-73', status: 'reserved');
        var changed = false;
        final gateway = _FakeWardIndentGateway(
          listRows: [initial],
          initialDetail: initial,
          listLoader: () async {
            if (changed && failingRead == 'list') {
              throw Exception('new target failed');
            }
            return WardIndentPage(items: [initial], hasMore: false);
          },
          detailLoader: (id) async {
            if (id == 74) throw Exception('new target failed');
            return initial;
          },
        );
        await _pumpWorkbench(
          tester,
          gateway: gateway,
          rawRole: 'PHARMACY_STAFF',
          initialIndentId: 73,
        );
        final oldAction = tester
            .widget<FilledButton>(
              find.byKey(const Key('ward-indent-action-approve')),
            )
            .onPressed!;
        changed = true;
        await _pumpWorkbench(
          tester,
          gateway: gateway,
          rawRole: 'PHARMACY_STAFF',
          initialIndentId: 74,
        );
        expect(find.textContaining('new target failed'), findsOneWidget);
        expect(find.byKey(const Key('ward-indent-row-73')), findsOneWidget);
        expect(find.byKey(const Key('ward-indent-detail-73')), findsNothing);
        expect(
          find.byKey(const Key('ward-indent-action-approve')),
          findsNothing,
        );
        expect(gateway.getIds, failingRead == 'detail' ? [73, 74] : [73]);
        oldAction();
        await tester.pumpAndSettle();
        expect(gateway.mutateCalls, 0);
        expect(find.text('Confirm'), findsNothing);
      },
    );
  }

  for (final fails in [false, true]) {
    testWidgets(
      'late mutation ${fails ? 'failure' : 'success'} preserves new selection and receipt identity',
      (tester) async {
        final initial = _indent(id: 73, number: 'WARD-73', status: 'reserved');
        final other = _indent(id: 74, number: 'WARD-74', status: 'reserved');
        final pending = Completer<WardIndent>();
        final attempts = IdempotencyAttemptRegistry();
        final gateway = _FakeWardIndentGateway(
          listRows: [initial, other],
          initialDetail: initial,
          detailLoader: (id) => Future.value(id == 73 ? initial : other),
          mutationLoader: (_) => pending.future,
        );
        await _pumpWorkbench(
          tester,
          gateway: gateway,
          rawRole: 'PHARMACY_STAFF',
          initialIndentId: 73,
          attempts: attempts,
        );
        await tester.ensureVisible(
          find.byKey(const Key('ward-indent-action-approve')),
        );
        await tester.tap(find.byKey(const Key('ward-indent-action-approve')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Confirm'));
        await tester.pump();
        expect(gateway.mutateCalls, 1);
        final originalKey = attempts.current('ward-indent:73:approve');
        expect(originalKey, isNotNull);
        await _pumpWorkbench(
          tester,
          gateway: gateway,
          rawRole: 'PHARMACY_STAFF',
          initialIndentId: 74,
          attempts: attempts,
          settle: false,
        );
        await _pumpUntilFound(
          tester,
          find.byKey(const Key('ward-indent-detail-74')),
        );
        final button = tester.widget<FilledButton>(
          find.byKey(const Key('ward-indent-action-approve')),
        );
        expect(button.onPressed, isNull);
        if (fails) {
          pending.completeError(Exception('old command response lost'));
        } else {
          pending.complete(
            _indent(id: 73, number: 'WARD-73', status: 'approved', version: 2),
          );
        }
        await tester.pumpAndSettle();
        expect(gateway.getIds, [73, 74]);
        expect(find.byKey(const Key('ward-indent-detail-74')), findsOneWidget);
        expect(find.byKey(const Key('ward-indent-action-error')), findsNothing);
        expect(find.byType(SnackBar), findsNothing);
        expect(
          attempts.current('ward-indent:73:approve'),
          fails ? originalKey : isNull,
        );
        expect(
          tester
              .widget<FilledButton>(
                find.byKey(const Key('ward-indent-action-approve')),
              )
              .onPressed,
          isNotNull,
        );
      },
    );
  }

  testWidgets(
    'mutation failure refresh cannot overwrite navigation that happens during the refresh',
    (tester) async {
      final initial = _indent(id: 73, number: 'WARD-73', status: 'reserved');
      final other = _indent(id: 74, number: 'WARD-74', status: 'reserved');
      final refresh = Completer<WardIndent>();
      var reads = 0;
      final gateway = _FakeWardIndentGateway(
        listRows: [initial, other],
        initialDetail: initial,
        detailLoader: (id) {
          if (id == 74) return Future.value(other);
          reads += 1;
          return reads == 1 ? Future.value(initial) : refresh.future;
        },
        mutateError: Exception('command conflict'),
      );
      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'PHARMACY_STAFF',
        initialIndentId: 73,
      );
      await tester.ensureVisible(
        find.byKey(const Key('ward-indent-action-approve')),
      );
      await tester.tap(find.byKey(const Key('ward-indent-action-approve')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm'));
      await tester.pump();
      expect(gateway.getIds, [73, 73]);
      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'PHARMACY_STAFF',
        initialIndentId: 74,
        settle: false,
      );
      await _pumpUntilFound(
        tester,
        find.byKey(const Key('ward-indent-detail-74')),
      );
      refresh.complete(
        _indent(id: 73, number: 'WARD-73', status: 'approved', version: 2),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('ward-indent-detail-74')), findsOneWidget);
      expect(find.byKey(const Key('ward-indent-action-error')), findsNothing);
    },
  );

  testWidgets(
    'late inventory candidates cannot continue reservation in a new selection',
    (tester) async {
      final initial = _indent(id: 73, number: 'WARD-73');
      final other = _indent(id: 74, number: 'WARD-74');
      final candidates = Completer<List<WardIndentInventoryItem>>();
      final gateway = _FakeWardIndentGateway(
        listRows: [initial, other],
        initialDetail: initial,
        detailLoader: (id) => Future.value(id == 73 ? initial : other),
        candidateLoader: () => candidates.future,
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
      await tester.pump();
      expect(gateway.inventoryCandidateCalls, 1);
      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'PHARMACY_STAFF',
        initialIndentId: 74,
        settle: false,
      );
      await _pumpUntilFound(
        tester,
        find.byKey(const Key('ward-indent-detail-74')),
      );
      candidates.complete(gateway.inventoryCandidates);
      await tester.pumpAndSettle();
      expect(gateway.mutateCalls, 0);
      expect(find.byKey(const Key('ward-indent-detail-74')), findsOneWidget);
      expect(find.byType(SimpleDialog), findsNothing);
    },
  );

  testWidgets('old success cannot clear a newer shared-registry attempt', (
    tester,
  ) async {
    final initial = _indent(id: 73, number: 'WARD-73', status: 'reserved');
    final pending = Completer<WardIndent>();
    final attempts = IdempotencyAttemptRegistry();
    final gateway = _FakeWardIndentGateway(
      listRows: [initial],
      initialDetail: initial,
      mutationLoader: (_) => pending.future,
    );
    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
      attempts: attempts,
    );
    await tester.ensureVisible(
      find.byKey(const Key('ward-indent-action-approve')),
    );
    await tester.tap(find.byKey(const Key('ward-indent-action-approve')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm'));
    await tester.pump();
    final oldKey = gateway.lastIdempotencyKey;
    final newerKey = attempts.keyFor('ward-indent:73:approve', {
      'expected_version': 2,
    });
    expect(newerKey, isNot(oldKey));
    pending.complete(
      _indent(id: 73, number: 'WARD-73', status: 'approved', version: 2),
    );
    await tester.pumpAndSettle();
    expect(attempts.current('ward-indent:73:approve'), newerKey);
  });

  for (final stage in ['candidates', 'request', 'credentials', 'approval']) {
    for (final invalidation in ['navigation', 'offline']) {
      testWidgets('controlled $stage continuation stops after $invalidation', (
        tester,
      ) async {
        final initial = _controlledIndent();
        final other = _indent(id: 74, number: 'WARD-74');
        final candidates = Completer<List<WardIndentInventoryItem>>();
        final request = Completer<Map<String, dynamic>>();
        final approval = Completer<Map<String, dynamic>>();
        final attempts = IdempotencyAttemptRegistry();
        final gateway = _FakeWardIndentGateway(
          listRows: [initial, other],
          initialDetail: initial,
          detailLoader: (id) => Future.value(id == 73 ? initial : other),
          inventoryCandidates: _controlledCandidates,
          candidateLoader: stage == 'candidates'
              ? () => candidates.future
              : null,
          witnessRequestLoader: stage == 'request'
              ? () => request.future
              : null,
          witnessApprovalLoader: stage == 'approval'
              ? () => approval.future
              : null,
        );
        await _pumpWorkbench(
          tester,
          gateway: gateway,
          rawRole: 'PHARMACY_STAFF',
          initialIndentId: 73,
          attempts: attempts,
        );
        await tester.ensureVisible(
          find.byKey(const Key('ward-indent-action-controlledHandoff')),
        );
        await tester.tap(
          find.byKey(const Key('ward-indent-action-controlledHandoff')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Confirm'));
        await tester.pump();
        if (stage == 'credentials' || stage == 'approval') {
          await _pumpUntilFound(
            tester,
            find.byKey(const Key('ward-indent-witness-employee-id')),
          );
          if (stage == 'approval') {
            await _submitWitness(tester);
            await tester.pump();
            expect(gateway.witnessApprovalCalls, 1);
          }
        }
        if (invalidation == 'navigation') {
          await _pumpWorkbench(
            tester,
            gateway: gateway,
            rawRole: 'PHARMACY_STAFF',
            initialIndentId: 74,
            attempts: attempts,
            settle: false,
          );
          await _pumpUntilFound(
            tester,
            find.byKey(const Key('ward-indent-detail-74'), skipOffstage: false),
          );
        } else {
          ConnectivitySyncService.instance.setConnectionStateForTesting(
            transport: ClientTransportState.unavailable,
            continuity: ContinuityLifecycleState.notReady,
          );
          await tester.pump();
        }
        if (stage == 'candidates') candidates.complete(_controlledCandidates);
        if (stage == 'request') request.complete({'id': 'approval-1'});
        if (stage == 'approval') approval.complete({'status': 'approved'});
        if (stage == 'credentials' ||
            (stage == 'request' && invalidation == 'offline')) {
          await _pumpUntilFound(
            tester,
            find.byKey(const Key('ward-indent-witness-employee-id')),
          );
          await _submitWitness(tester);
        }
        await tester.pumpAndSettle();
        expect(gateway.witnessRequestCalls, stage == 'candidates' ? 0 : 1);
        expect(gateway.witnessApprovalCalls, stage == 'approval' ? 1 : 0);
        expect(gateway.mutateCalls, 0);
        if (stage != 'candidates') {
          expect(
            attempts.current('ward-indent:73:controlled-witness-request:701'),
            isNull,
          );
        }
        if (invalidation == 'navigation') {
          expect(
            find.byKey(const Key('ward-indent-detail-74')),
            findsOneWidget,
          );
          expect(
            find.byKey(const Key('ward-indent-action-error')),
            findsNothing,
          );
          expect(find.byType(SnackBar), findsNothing);
        }
      });
    }
  }

  testWidgets(
    'unmounted historical-recovery dialog cannot continue or clear a disposed controller',
    (tester) async {
      final initial = _controlledIndent(historical: true);
      final gateway = _FakeWardIndentGateway(
        listRows: [initial],
        initialDetail: initial,
      );
      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'PHARMACY_INCHARGE',
        initialIndentId: 73,
      );
      await tester.ensureVisible(
        find.byKey(const Key('ward-indent-action-controlledHandoff')),
      );
      await tester.tap(
        find.byKey(const Key('ward-indent-action-controlledHandoff')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm'));
      await _pumpUntilFound(
        tester,
        find.byKey(const Key('ward-indent-historical-recovery-reason-701')),
      );
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(gateway.mutateCalls, 0);
    },
  );

  testWidgets(
    'newer refresh wins when two reads of the same indent finish backwards',
    (tester) async {
      final initial = _indent(id: 73, number: 'WARD-73');
      final older = Completer<WardIndent>();
      final newer = Completer<WardIndent>();
      var reads = 0;
      final gateway = _FakeWardIndentGateway(
        listRows: [initial],
        initialDetail: initial,
        detailLoader: (_) {
          reads += 1;
          return reads == 1
              ? Future.value(initial)
              : reads == 2
              ? older.future
              : newer.future;
        },
      );
      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'PHARMACY_STAFF',
        initialIndentId: 73,
      );
      final refresh = _detailRefresh(tester, 73);
      final first = refresh();
      final second = refresh();
      newer.complete(_indent(id: 73, number: 'WARD-73', version: 3));
      await second;
      await tester.pumpAndSettle();
      expect(find.text('v3'), findsOneWidget);
      older.complete(_indent(id: 73, number: 'WARD-73', version: 2));
      await first;
      await tester.pumpAndSettle();
      expect(find.text('v3'), findsOneWidget);
      expect(find.text('v2'), findsNothing);
    },
  );

  testWidgets('current refresh failure remains visible and a retry clears it', (
    tester,
  ) async {
    final initial = _indent(id: 73, number: 'WARD-73');
    var reads = 0;
    final gateway = _FakeWardIndentGateway(
      listRows: [initial],
      initialDetail: initial,
      detailLoader: (_) async {
        reads += 1;
        if (reads == 2) throw Exception('current refresh failed');
        return initial;
      },
    );
    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );
    await _detailRefresh(tester, 73)();
    await tester.pumpAndSettle();
    expect(find.textContaining('current refresh failed'), findsOneWidget);
    await _detailRefresh(tester, 73)();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('ward-indent-action-error')), findsNothing);
  });

  testWidgets(
    'obsolete worklist response cannot start a detail read on a replacement gateway',
    (tester) async {
      final initial = _indent(id: 73, number: 'WARD-73');
      final other = _indent(id: 74, number: 'WARD-74');
      final page = Completer<WardIndentPage>();
      final oldGateway = _FakeWardIndentGateway(
        listRows: [initial],
        initialDetail: initial,
        listLoader: () => page.future,
      );
      final newGateway = _FakeWardIndentGateway(
        listRows: [other],
        initialDetail: other,
      );
      await _pumpWorkbench(
        tester,
        gateway: oldGateway,
        rawRole: 'PHARMACY_STAFF',
        initialIndentId: 73,
        settle: false,
      );
      await _pumpWorkbench(
        tester,
        gateway: newGateway,
        rawRole: 'PHARMACY_STAFF',
        initialIndentId: 74,
      );
      page.complete(WardIndentPage(items: [initial], hasMore: false));
      await tester.pumpAndSettle();
      expect(oldGateway.getIds, isEmpty);
      expect(newGateway.getIds, [74]);
      expect(find.byKey(const Key('ward-indent-detail-74')), findsOneWidget);
    },
  );

  testWidgets('late request-sheet result does not replace a new deep link', (
    tester,
  ) async {
    final initial = _indent(id: 73, number: 'WARD-73');
    final other = _indent(id: 74, number: 'WARD-74');
    final gateway = _FakeWardIndentGateway(
      listRows: [initial, other],
      initialDetail: initial,
      detailLoader: (id) => Future.value(id == 73 ? initial : other),
    );
    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );
    await tester.tap(find.byKey(const Key('ward-indent-request-open')));
    await tester.pumpAndSettle();
    expect(find.byType(WardIndentRequestSheet), findsOneWidget);
    final sheetContext = tester.element(find.byType(WardIndentRequestSheet));
    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 74,
    );
    Navigator.of(sheetContext).pop(_indent(id: 75, number: 'WARD-75'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('ward-indent-detail-74')), findsOneWidget);
    expect(find.byType(SnackBar), findsNothing);
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
    expect(find.byKey(const Key('ward-indent-request-open')), findsOneWidget);
  });

  testWidgets('stores-only actor cannot open the clinical request flow', (
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
      rawRole: 'STORES_PURCHASE_INCHARGE',
      initialIndentId: 73,
    );

    expect(find.byKey(const Key('ward-indent-request-open')), findsNothing);
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
    final request = tester.widget<FilledButton>(
      find.byKey(const Key('ward-indent-request-open')),
    );
    expect(request.onPressed, isNull);
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

  testWidgets(
    'fresh controlled dispense uses an independent witness approval',
    (tester) async {
      final pending = _indent(
        id: 73,
        number: 'WARD-73',
        status: 'controlled_handoff_required',
        version: 3,
        quantityReserved: 2,
        quantityApproved: 2,
        controlledReference: 'ward-indent:73:item:701',
        recovery: const {
          'item_id': 701,
          'status': 'missing',
          'candidate_count': 0,
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
    },
  );

  testWidgets(
    'controlled handoff stays hidden when recovery classification is omitted',
    (tester) async {
      final incomplete = _indent(
        id: 73,
        number: 'WARD-73',
        status: 'controlled_handoff_required',
        version: 3,
        quantityReserved: 2,
        quantityApproved: 2,
        controlledReference: 'ward-indent:73:item:701',
      );
      final gateway = _FakeWardIndentGateway(
        listRows: [incomplete],
        initialDetail: incomplete,
      );

      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'PHARMACY_STAFF',
        initialIndentId: 73,
      );

      expect(
        find.byKey(const Key('ward-indent-action-controlledHandoff')),
        findsNothing,
      );
      expect(gateway.witnessRequestCalls, 0);
      expect(gateway.mutateCalls, 0);
    },
  );

  testWidgets(
    'pharmacy in-charge explicitly selects unique historical evidence with a reason',
    (tester) async {
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
        listRows: [recoverable],
        initialDetail: recoverable,
        mutationResult: completed,
      );

      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'PHARMACY_INCHARGE',
        initialIndentId: 73,
      );
      final action = find.byKey(
        const Key('ward-indent-action-controlledHandoff'),
      );
      await tester.ensureVisible(action);
      await tester.tap(action);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm'));
      // The workbench stays _mutating for as long as the recovery dialog is
      // open, and _mutating renders an indeterminate LinearProgressIndicator —
      // pumpAndSettle can never settle against one. Pump the dialog's entrance
      // transition by hand instead.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      final reason = find.byKey(
        const Key('ward-indent-historical-recovery-reason-701'),
      );
      final confirm = find.byKey(
        const Key('ward-indent-historical-recovery-confirm-701'),
      );
      expect(reason, findsOneWidget);
      expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
      await tester.enterText(
        reason,
        'Verified against the signed ward register',
      );
      await tester.pump();
      expect(tester.widget<FilledButton>(confirm).onPressed, isNotNull);
      await tester.tap(confirm);
      await tester.pumpAndSettle();

      expect(gateway.witnessRequestCalls, 0);
      expect(gateway.witnessApprovalCalls, 0);
      expect(gateway.inventoryCandidateCalls, 0);
      expect(gateway.lastAction, WardIndentAction.controlledHandoff);
      expect(gateway.lastPayload?['item_evidence'], [
        {
          'item_id': 701,
          'historical_recovery': {
            'movement_id': 801,
            'register_id': 901,
            'reason': 'Verified against the signed ward register',
          },
        },
      ]);
    },
  );

  testWidgets('corrupt controlled recovery blocks dispense and handoff', (
    tester,
  ) async {
    final corrupt = _indent(
      id: 73,
      number: 'WARD-73',
      status: 'controlled_handoff_required',
      version: 3,
      quantityReserved: 2,
      quantityApproved: 2,
      controlledReference: 'ward-indent:73:item:701',
      recovery: const {
        'item_id': 701,
        'status': 'corrupt',
        'candidate_count': 2,
      },
    );
    final gateway = _FakeWardIndentGateway(
      listRows: [corrupt],
      initialDetail: corrupt,
    );

    await _pumpWorkbench(
      tester,
      gateway: gateway,
      rawRole: 'PHARMACY_STAFF',
      initialIndentId: 73,
    );
    expect(
      find.byKey(const Key('ward-indent-action-controlledHandoff')),
      findsNothing,
    );
    expect(gateway.witnessRequestCalls, 0);
    expect(gateway.mutateCalls, 0);
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

  // Stock is bound when the supply side APPLIES an already-approved
  // substitution: substitutions/approve is the prescriber's decision and
  // carries no inventory, while substitutions/apply is the supply-role write
  // that resolves the proposed catalog. Driving the prescriber's action here
  // would assert a doctor picking pharmacy inventory, which both the role
  // policy and the backend route refuse.
  testWidgets(
    'applying an approved substitution scopes stock to the indent facility',
    (tester) async {
      final approved = _indent(
        id: 73,
        number: 'WARD-73',
        status: 'substitution_pending',
        ownerRoles: const ['PHARMACY_STAFF'],
        substitutionStatus: 'approved',
        proposedName: 'Composition-safe alternate',
        proposedCatalogId: 102,
        proposedQuantity: 2,
        facilityId: 8,
      );
      final gateway = _FakeWardIndentGateway(
        listRows: [approved],
        initialDetail: approved,
        inventoryItems: const [
          WardIndentInventoryItem(
            id: 992,
            catalogId: 102,
            facilityId: 8,
            displayName: 'Proposed stock',
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
      final action = find.byKey(
        const Key('ward-indent-action-applyApprovedSubstitution'),
      );
      await tester.ensureVisible(action);
      await tester.tap(action);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();

      expect(gateway.lastInventoryCatalogId, 102);
      expect(gateway.lastInventoryFacilityId, 8);
      expect(gateway.lastAction, WardIndentAction.applyApprovedSubstitution);
      expect(gateway.lastPayload, {
        'inventory_selections': [
          {'item_id': 701, 'inventory_item_id': 992},
        ],
      });
    },
  );

  testWidgets(
    'approved substitution fails closed when indent facility authority is missing',
    (tester) async {
      final approved = _indent(
        id: 73,
        number: 'WARD-73',
        status: 'substitution_pending',
        ownerRoles: const ['PHARMACY_STAFF'],
        substitutionStatus: 'approved',
        proposedName: 'Composition-safe alternate',
        proposedCatalogId: 102,
        proposedQuantity: 2,
      );
      final gateway = _FakeWardIndentGateway(
        listRows: [approved],
        initialDetail: approved,
      );

      await _pumpWorkbench(
        tester,
        gateway: gateway,
        rawRole: 'PHARMACY_STAFF',
        initialIndentId: 73,
      );
      final action = find.byKey(
        const Key('ward-indent-action-applyApprovedSubstitution'),
      );
      await tester.ensureVisible(action);
      await tester.tap(action);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm'));
      await tester.pumpAndSettle();

      expect(gateway.lastInventoryFacilityId, isNull);
      expect(gateway.lastInventoryCatalogId, isNull);
      expect(gateway.mutateCalls, 0);
      expect(find.textContaining('active pharmacy grants'), findsOneWidget);
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
      expect(
        gateway.lastPayload?.containsKey('controlled_return_evidence'),
        isFalse,
      );
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
  StaffRole? role,
  WardIndentRequesterGateway? requesterGateway,
  int? initialIndentId,
  IdempotencyAttemptRegistry? attempts,
  bool settle = true,
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
          role: role ?? StaffRole.fromString(rawRole),
          initialIndentId: initialIndentId,
          gateway: gateway,
          requesterGateway: requesterGateway,
          attempts: attempts ?? IdempotencyAttemptRegistry(),
        ),
      ),
    ),
  );
  if (settle) await tester.pumpAndSettle();
}

Future<void> _pumpUntilFound(WidgetTester tester, Finder finder) async {
  for (var attempt = 0; attempt < 40; attempt += 1) {
    await tester.pump(const Duration(milliseconds: 50));
    if (finder.evaluate().isNotEmpty) return;
  }
  fail('Timed out waiting for the requested ward-indent widget');
}

RefreshCallback _detailRefresh(WidgetTester tester, int id) => tester
    .widget<RefreshIndicator>(
      find.ancestor(
        of: find.byKey(Key('ward-indent-detail-$id'), skipOffstage: false),
        matching: find.byType(RefreshIndicator, skipOffstage: false),
      ),
    )
    .onRefresh;

Future<void> _submitWitness(WidgetTester tester) async {
  await tester.enterText(
    find.byKey(const Key('ward-indent-witness-employee-id')),
    'wit-2',
  );
  await tester.enterText(
    find.byKey(const Key('ward-indent-witness-password')),
    'secret',
  );
  await tester.tap(find.byKey(const Key('ward-indent-witness-confirm')));
}

WardIndent _controlledIndent({bool historical = false}) => _indent(
  id: 73,
  number: 'WARD-73',
  status: 'controlled_handoff_required',
  version: 3,
  quantityReserved: 2,
  quantityApproved: 2,
  controlledReference: 'ward-indent:73:item:701',
  recovery: historical
      ? const {
          'item_id': 701,
          'status': 'available',
          'candidate_count': 1,
          'movement_id': 801,
          'register_id': 901,
        }
      : const {'item_id': 701, 'status': 'missing', 'candidate_count': 0},
);

const _controlledCandidates = [
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
];

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
    this.detailLoader,
    this.listLoader,
    this.mutationLoader,
    this.candidateLoader,
    this.witnessRequestLoader,
    this.witnessApprovalLoader,
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
  final Future<WardIndent> Function(int id)? detailLoader;
  final Future<WardIndentPage> Function()? listLoader;
  final Future<WardIndent> Function(WardIndent indent)? mutationLoader;
  final Future<List<WardIndentInventoryItem>> Function()? candidateLoader;
  final Future<Map<String, dynamic>> Function()? witnessRequestLoader;
  final Future<Map<String, dynamic>> Function()? witnessApprovalLoader;
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
  int? lastInventoryFacilityId;

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
    if (listLoader != null) return listLoader!();
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
    if (detailLoader != null) return detailLoader!(id);
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
    if (mutationLoader != null) return mutationLoader!(indent);
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
    required int facilityId,
    int? catalogId,
  }) async {
    lastInventoryFacilityId = facilityId;
    lastInventoryCatalogId = catalogId;
    return inventoryItems;
  }

  @override
  Future<List<WardIndentInventoryBatch>> listInventoryBatches(
    int itemId, {
    required int facilityId,
  }) async {
    return const [];
  }

  @override
  Future<List<WardIndentInventoryItem>> listInventoryCandidates(
    int indentId,
    int itemId,
  ) async {
    inventoryCandidateCalls += 1;
    if (candidateLoader != null) return candidateLoader!();
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
    if (witnessRequestLoader != null) return witnessRequestLoader!();
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
    if (witnessApprovalLoader != null) return witnessApprovalLoader!();
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
