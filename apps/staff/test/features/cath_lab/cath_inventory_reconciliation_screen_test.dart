import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/models/client_readiness.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/core/services/idempotency_attempt_registry.dart';
import 'package:vhhealth_staff/features/cath_lab/screens/cath_inventory_reconciliation_screen.dart';
import 'package:vhhealth_staff/features/cath_lab/services/cath_lab_api_service.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

CathInventoryReconciliation _detail({
  String status = 'insufficient_stock',
  bool actionable = true,
  String taskStatus = 'open',
  String slaStatus = 'active',
  String caseId = '7',
  String usageId = '73',
}) {
  return CathInventoryReconciliation(
    caseId: caseId,
    usageId: usageId,
    patientUid: '11111111-1111-4111-8111-111111111111',
    itemName: 'Drug-eluting stent',
    catalogItemId: '17',
    inventoryItemId: '83',
    inventoryBatchId: '93',
    batchNumber: 'BATCH-93',
    documentedQuantity: 2,
    decrementedQuantity: status == 'decremented' ? 2 : 0,
    remainingQuantity: status == 'decremented' ? 3 : 0,
    inventoryDecrementStatus: status,
    inventoryWarning: status == 'decremented' ? '' : 'Stock unavailable',
    taskId: '103',
    taskStatus: taskStatus,
    workflowSlaInstanceId: '22222222-2222-4222-8222-222222222222',
    slaStatus: slaStatus,
    dueAt: DateTime.utc(2026, 8, 28, 12),
    actionable: actionable,
  );
}

CathInventoryReconciliation get _completed => _detail(
  status: 'decremented',
  actionable: false,
  taskStatus: 'completed',
  slaStatus: 'completed',
);

Widget _screen({
  String role = 'PHARMACIST',
  required CathInventoryReconciliationLoader load,
  CathInventoryReconciler? reconcile,
  IdempotencyAttemptRegistry? attempts,
}) {
  return ChangeNotifierProvider<ThemeProvider>(
    create: (_) => ThemeProvider(),
    child: MaterialApp(
      home: CathInventoryReconciliationScreen(
        caseId: '7',
        consumableUsageId: '73',
        loadRole: () async => role,
        loadReconciliation: load,
        reconcileInventory: reconcile,
        attempts: attempts,
      ),
    ),
  );
}

void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1400, 3200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

Future<void> _confirmAction(WidgetTester tester) async {
  final action = find.byKey(const ValueKey('cath-inventory-reconcile'));
  await tester.ensureVisible(action);
  await tester.tap(action);
  await tester.pumpAndSettle();
  await tester.tap(
    find.byKey(const ValueKey('cath-inventory-reconcile-confirm')),
  );
  await tester.pumpAndSettle();
}

void main() {
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

  test('route roles are exact and fail closed', () {
    const operators = ['PHARMACIST', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE'];
    for (final role in operators) {
      expect(cathInventoryReconciliationCanOpen(role), isTrue, reason: role);
      expect(
        cathInventoryReconciliationCanReconcile(role),
        isTrue,
        reason: role,
      );
    }
    for (final role in const ['ADMIN', 'SUPER_ADMIN']) {
      expect(cathInventoryReconciliationCanOpen(role), isTrue, reason: role);
      expect(
        cathInventoryReconciliationCanReconcile(role),
        isFalse,
        reason: role,
      );
    }
    expect(cathInventoryReconciliationCanOpen('DOCTOR'), isFalse);
    expect(cathInventoryReconciliationCanReconcile('DOCTOR'), isFalse);
    expect(cathInventoryReconciliationCanOpen('CATH_LAB_STAFF'), isFalse);
    expect(cathInventoryReconciliationCanOpen('RECEPTIONIST'), isFalse);
  });

  testWidgets('unauthorized roles cannot load authoritative evidence', (
    tester,
  ) async {
    var loads = 0;
    await tester.pumpWidget(
      _screen(
        role: 'DOCTOR',
        load: (_, _) async {
          loads++;
          return _detail();
        },
      ),
    );
    await tester.pumpAndSettle();

    expect(loads, 0);
    expect(find.textContaining('not authorized'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('cath-inventory-reconcile')),
      findsNothing,
    );
  });

  testWidgets('mismatched case and usage evidence fails closed', (
    tester,
  ) async {
    await tester.pumpWidget(
      _screen(load: (_, _) async => _detail(usageId: '74')),
    );
    await tester.pumpAndSettle();

    expect(
      find.textContaining('do not match the authoritative'),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('cath-inventory-reconcile')),
      findsNothing,
    );
  });

  testWidgets('coverage administrators may view but cannot reconcile', (
    tester,
  ) async {
    _useTallViewport(tester);
    var loads = 0;
    var mutations = 0;
    await tester.pumpWidget(
      _screen(
        role: 'ADMIN',
        load: (_, _) async {
          loads++;
          return _detail();
        },
        reconcile: (_, _, {required idempotencyKey}) async {
          mutations++;
          return CathInventoryReconciliationResult(
            outcome: 'completed',
            reconciliation: _completed,
          );
        },
      ),
    );
    await tester.pumpAndSettle();

    expect(loads, 1);
    expect(find.textContaining('Coverage administrators'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('cath-inventory-reconcile')),
      findsNothing,
    );
    expect(mutations, 0);
  });

  testWidgets('unknown backend inventory warning never renders raw text', (
    tester,
  ) async {
    _useTallViewport(tester);
    await tester.pumpWidget(_screen(load: (_, _) async => _detail()));
    await tester.pumpAndSettle();

    expect(find.text('Stock unavailable'), findsNothing);
    expect(
      find.text(
        AppStrings.forLocale(const Locale('en'))
            .lookup('med03.cath_inventory.warning.unknown'),
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'ambiguous response survives screen reopen and reuses the same key',
    (tester) async {
      _useTallViewport(tester);
      final attempts = IdempotencyAttemptRegistry();
      var current = _detail();
      var calls = 0;
      var loads = 0;
      final keys = <String>[];

      Future<CathInventoryReconciliationResult> reconcile(
        String caseId,
        String usageId, {
        required String idempotencyKey,
      }) async {
        keys.add(idempotencyKey);
        calls++;
        if (calls == 1) throw Exception('response lost');
        current = _completed;
        return CathInventoryReconciliationResult(
          outcome: 'completed',
          reconciliation: current,
        );
      }

      await tester.pumpWidget(
        _screen(
          load: (_, _) async {
            loads++;
            return current;
          },
          reconcile: reconcile,
          attempts: attempts,
        ),
      );
      await tester.pumpAndSettle();
      await _confirmAction(tester);
      expect(keys, hasLength(1));
      expect(loads, 2);
      expect(find.textContaining('outcome is not confirmed'), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      await tester.pumpWidget(
        _screen(
          load: (_, _) async => current,
          reconcile: reconcile,
          attempts: attempts,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Retry protected reconciliation'), findsOneWidget);
      await _confirmAction(tester);

      expect(keys, hasLength(2));
      expect(keys[1], keys[0]);
      expect(
        find.byKey(const ValueKey('cath-inventory-reconcile')),
        findsNothing,
      );
      expect(find.textContaining('workflow closure'), findsWidgets);
    },
  );

  testWidgets(
    'lost response refreshes authoritative closure and clears the attempt',
    (tester) async {
      _useTallViewport(tester);
      final attempts = IdempotencyAttemptRegistry();
      var current = _detail();
      var loads = 0;
      final keys = <String>[];

      await tester.pumpWidget(
        _screen(
          load: (_, _) async {
            loads++;
            return current;
          },
          reconcile: (_, _, {required idempotencyKey}) async {
            keys.add(idempotencyKey);
            current = _completed;
            throw Exception('response lost after commit');
          },
          attempts: attempts,
        ),
      );
      await tester.pumpAndSettle();
      await _confirmAction(tester);

      expect(loads, 2);
      expect(keys, hasLength(1));
      expect(attempts.current('cath-inventory-reconcile:7:73'), isNull);
      expect(
        find.byKey(const ValueKey('cath-inventory-reconcile')),
        findsNothing,
      );
      expect(find.textContaining('workflow closure'), findsWidgets);
      expect(find.textContaining('outcome is not confirmed'), findsNothing);
    },
  );

  testWidgets('definitive shortfall closes one attempt but keeps task open', (
    tester,
  ) async {
    _useTallViewport(tester);
    final attempts = IdempotencyAttemptRegistry();
    final keys = <String>[];
    Future<CathInventoryReconciliationResult> reconcile(
      String caseId,
      String usageId, {
      required String idempotencyKey,
    }) async {
      keys.add(idempotencyKey);
      return CathInventoryReconciliationResult(
        outcome: 'still_insufficient',
        reconciliation: _detail(),
      );
    }

    await tester.pumpWidget(
      _screen(
        load: (_, _) async => _detail(),
        reconcile: reconcile,
        attempts: attempts,
      ),
    );
    await tester.pumpAndSettle();
    await _confirmAction(tester);
    expect(find.textContaining('task remains open'), findsOneWidget);
    await _confirmAction(tester);

    expect(keys, hasLength(2));
    expect(keys[1], isNot(keys[0]));
  });

  testWidgets('in-flight and offline states suppress duplicate mutations', (
    tester,
  ) async {
    _useTallViewport(tester);
    final pending = Completer<CathInventoryReconciliationResult>();
    var calls = 0;
    await tester.pumpWidget(
      _screen(
        load: (_, _) async => _detail(),
        reconcile: (_, _, {required idempotencyKey}) {
          calls++;
          return pending.future;
        },
      ),
    );
    await tester.pumpAndSettle();
    final action = find.byKey(const ValueKey('cath-inventory-reconcile'));
    await tester.ensureVisible(action);
    await tester.tap(action);
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('cath-inventory-reconcile-confirm')),
    );
    await tester.pump();
    expect(tester.widget<FilledButton>(action).onPressed, isNull);
    await tester.tap(action, warnIfMissed: false);
    expect(calls, 1);
    pending.complete(
      CathInventoryReconciliationResult(
        outcome: 'still_insufficient',
        reconciliation: _detail(),
      ),
    );
    await tester.pumpAndSettle();

    ConnectivitySyncService.instance.setConnectionStateForTesting(
      transport: ClientTransportState.unavailable,
      continuity: ContinuityLifecycleState.notReady,
    );
    await tester.pump();
    expect(tester.widget<FilledButton>(action).onPressed, isNull);
  });

  testWidgets(
    'inventory decrement alone cannot masquerade as workflow closure',
    (tester) async {
      _useTallViewport(tester);
      final incomplete = _detail(
        status: 'decremented',
        actionable: false,
        taskStatus: 'open',
        slaStatus: 'active',
      );
      await tester.pumpWidget(_screen(load: (_, _) async => incomplete));
      await tester.pumpAndSettle();

      expect(incomplete.isCompleted, isFalse);
      expect(find.textContaining('not currently actionable'), findsOneWidget);
      expect(find.textContaining('workflow closure'), findsNothing);
    },
  );
}
