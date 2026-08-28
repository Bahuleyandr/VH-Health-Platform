import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/models/client_readiness.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/reception/screens/counter_sale_refund_screen.dart';

Map<String, dynamic> _detail({
  String approvalStatus = 'PENDING',
  String mode = 'UPI',
  String? approvedBy,
  String? payoutRail,
  List<String> allowedRails = const [],
  String workflowStatus = 'awaiting_approval',
  Map<String, dynamic>? evidence,
  bool counterSale = true,
}) {
  return {
    'refund': {
      'id': 7,
      if (counterSale) 'counter_sale_void_request_id': 17,
      'invoice_id': 27,
      'amount': '25.00',
      'mode': mode,
      'approval_status': approvalStatus,
      'approved_by': ?approvedBy,
      'payout_rail': ?payoutRail,
      if (evidence != null) 'offline_electronic_evidence_id': evidence['id'],
    },
    'void_request': counterSale
        ? {
            'id': 17,
            'refund_id': 7,
            'counter_sale_id': 37,
            'status': approvalStatus == 'PAID' ? 'COMPLETED' : 'PENDING_REFUND',
            'disposition': 'NEVER_HANDED_OVER',
          }
        : null,
    'original_payment': {
      'id': 47,
      'mode': mode,
      'reference': 'UPI-ORIGINAL-7',
      'provider_name': 'Original Acquirer',
    },
    'offline_electronic_evidence': evidence,
    'workflow_status': workflowStatus,
    'allowed_payout_rails': allowedRails,
  };
}

Widget _screen({
  String role = 'ADMIN',
  String? staffUid = 'staff-7',
  required CounterSaleRefundGetter getRefund,
  CounterSaleRefundApprover? approveRefund,
  CounterSaleRefundManualPayer? payManualRefund,
  CounterSaleRefundOfflineElectronicPayer? payOfflineElectronicRefund,
  CounterSaleRefundCashDrawerLister? listCashDrawerSessions,
  CounterSaleRefundGatewayCandidateLister? listGatewayCandidates,
  CounterSaleRefundGatewayStarter? startGatewayRefund,
  String voidRequestId = '17',
}) {
  return ChangeNotifierProvider<ThemeProvider>(
    create: (_) => ThemeProvider(),
    child: MaterialApp(
      home: CounterSaleRefundScreen(
        refundId: '7',
        voidRequestId: voidRequestId,
        roleLoader: () async => role,
        staffUidLoader: () async => staffUid,
        getRefund: getRefund,
        approveRefund: approveRefund,
        payManualRefund: payManualRefund,
        payOfflineElectronicRefund: payOfflineElectronicRefund,
        listCashDrawerSessions: listCashDrawerSessions,
        listGatewayCandidates: listGatewayCandidates,
        startGatewayRefund: startGatewayRefund,
      ),
    ),
  );
}

void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 3200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

Future<void> _confirmVisibleAction(WidgetTester tester, Finder action) async {
  await tester.ensureVisible(action);
  await tester.tap(action);
  await tester.pumpAndSettle();
  final confirm = find.descendant(
    of: find.byType(AlertDialog),
    matching: find.byType(FilledButton),
  );
  await tester.tap(confirm);
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

  test('route, approval, and payout roles are exact and fail closed', () {
    for (final role in const [
      'ADMIN',
      'SUPER_ADMIN',
      'FINANCE_INCHARGE',
      'BILLING_INCHARGE',
      'BILLING_STAFF',
      'CASHIER',
    ]) {
      expect(counterSaleRefundCanOpen(role), isTrue, reason: role);
      expect(counterSaleRefundCanPay(role), isTrue, reason: role);
    }
    expect(counterSaleRefundCanApprove('ADMIN'), isTrue);
    expect(counterSaleRefundCanApprove('SUPER_ADMIN'), isTrue);
    expect(counterSaleRefundCanApprove('CASHIER'), isFalse);
    expect(counterSaleRefundCanOpen('BILLING_STAFF'), isTrue);
    expect(counterSaleRefundCanOpen('NURSE'), isFalse);
  });

  testWidgets('unauthorized role cannot load authoritative refund data', (
    tester,
  ) async {
    var getterCalls = 0;
    await tester.pumpWidget(
      _screen(
        role: 'NURSE',
        getRefund: (_) async {
          getterCalls++;
          return _detail();
        },
      ),
    );
    await tester.pumpAndSettle();

    expect(getterCalls, 0);
    expect(find.textContaining('not authorized'), findsOneWidget);
  });

  testWidgets('generic medication refund opens without counter-sale identity', (
    tester,
  ) async {
    _useTallViewport(tester);
    await tester.pumpWidget(
      _screen(
        role: 'BILLING_STAFF',
        voidRequestId: '',
        getRefund: (_) async => _detail(
          approvalStatus: 'APPROVED',
          allowedRails: const ['offline_electronic'],
          workflowStatus: 'ready_for_payout',
          counterSale: false,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('not identify the same'), findsNothing);
    expect(
      find.byKey(const ValueKey('counter-sale-refund-offline-electronic-rail')),
      findsOneWidget,
    );
    expect(find.text('17'), findsNothing);
  });

  testWidgets('mismatched refund and void identifiers fail closed', (
    tester,
  ) async {
    final mismatched = _detail();
    (mismatched['void_request'] as Map<String, dynamic>)['refund_id'] = 8;
    await tester.pumpWidget(_screen(getRefund: (_) async => mismatched));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('do not identify the same authoritative workflow'),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('counter-sale-refund-approve')),
      findsNothing,
    );
  });

  testWidgets(
    'authoritative offline-electronic rail never renders cash or gateway',
    (tester) async {
      _useTallViewport(tester);
      await tester.pumpWidget(
        _screen(
          role: 'CASHIER',
          getRefund: (_) async => _detail(
            approvalStatus: 'APPROVED',
            allowedRails: const ['offline_electronic'],
            workflowStatus: 'ready_for_payout',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(
          const ValueKey('counter-sale-refund-offline-electronic-rail'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('counter-sale-refund-manual-rail')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('counter-sale-refund-gateway-rail')),
        findsNothing,
      );
      expect(find.text('PENDING_REFUND'), findsNothing);
    },
  );

  testWidgets('integrated gateway ownership exposes no manual escape hatch', (
    tester,
  ) async {
    _useTallViewport(tester);
    await tester.pumpWidget(
      _screen(
        role: 'CASHIER',
        getRefund: (_) async => _detail(
          approvalStatus: 'APPROVED',
          allowedRails: const ['gateway'],
          workflowStatus: 'ready_for_payout',
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('counter-sale-refund-gateway-rail')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('counter-sale-refund-manual-rail')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('counter-sale-refund-offline-electronic-rail')),
      findsNothing,
    );
  });

  testWidgets(
    'lost approval response retries with the same key and authoritative refresh',
    (tester) async {
      _useTallViewport(tester);
      var detail = _detail();
      var calls = 0;
      final keys = <String>[];
      await tester.pumpWidget(
        _screen(
          getRefund: (_) async => detail,
          approveRefund: (refundId, {required idempotencyKey}) async {
            keys.add(idempotencyKey);
            calls++;
            if (calls == 1) throw Exception('response lost after approval');
            detail = _detail(
              approvalStatus: 'APPROVED',
              approvedBy: 'approver-7',
              allowedRails: const ['offline_electronic'],
              workflowStatus: 'ready_for_payout',
            );
            return detail;
          },
        ),
      );
      await tester.pumpAndSettle();

      final approve = find.byKey(const ValueKey('counter-sale-refund-approve'));
      await _confirmVisibleAction(tester, approve);
      expect(keys, hasLength(1));
      expect(approve, findsOneWidget);
      await _confirmVisibleAction(tester, approve);

      expect(keys, hasLength(2));
      expect(keys[1], keys[0]);
      expect(
        find.byKey(const ValueKey('counter-sale-refund-approve')),
        findsNothing,
      );
      expect(find.text('Approved and ready for payout'), findsOneWidget);
    },
  );

  testWidgets(
    'changed external evidence requires a new protected payout attempt',
    (tester) async {
      _useTallViewport(tester);
      var detail = _detail(
        approvalStatus: 'APPROVED',
        approvedBy: 'approver-7',
        allowedRails: const ['offline_electronic'],
        workflowStatus: 'ready_for_payout',
      );
      var calls = 0;
      final keys = <String>[];
      await tester.pumpWidget(
        _screen(
          role: 'CASHIER',
          getRefund: (_) async => detail,
          payOfflineElectronicRefund:
              ({
                required refundId,
                required originalPaymentReference,
                required providerName,
                required providerRefundReference,
                required providerRefundedAt,
                required idempotencyKey,
              }) async {
                keys.add(idempotencyKey);
                calls++;
                if (calls == 1) throw Exception('provider response lost');
                final evidence = {
                  'id': 57,
                  'provider_name': providerName,
                  'provider_refund_reference': providerRefundReference,
                };
                detail = _detail(
                  approvalStatus: 'PAID',
                  approvedBy: 'approver-7',
                  payoutRail: 'offline_electronic',
                  workflowStatus: 'reconciliation_required',
                  evidence: evidence,
                );
                return detail;
              },
        ),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const ValueKey('counter-sale-refund-provider-reference')),
        'PROVIDER-REFUND-ONE',
      );
      await tester.enterText(
        find.byKey(const ValueKey('counter-sale-refund-provider-refunded-at')),
        '2026-08-28T10:30:00+05:30',
      );
      await tester.pump();
      final pay = find.byKey(
        const ValueKey('counter-sale-refund-pay-offline-electronic'),
      );
      await _confirmVisibleAction(tester, pay);
      expect(keys, hasLength(1));

      await tester.enterText(
        find.byKey(const ValueKey('counter-sale-refund-provider-reference')),
        'PROVIDER-REFUND-TWO',
      );
      await tester.pump();
      await tester.tap(pay);
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byType(FilledButton),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('counter-sale-refund-new-attempt')),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(const ValueKey('counter-sale-refund-new-attempt')),
      );
      await tester.pumpAndSettle();

      expect(keys, hasLength(2));
      expect(keys[1], isNot(keys[0]));
      expect(
        find.text('Refund paid; pharmacy reconciliation required'),
        findsOneWidget,
      );
      expect(find.text('PROVIDER-REFUND-TWO'), findsOneWidget);
    },
  );

  testWidgets('offline state disables the authoritative payout action', (
    tester,
  ) async {
    ConnectivitySyncService.instance.setConnectionStateForTesting(
      transport: ClientTransportState.unavailable,
      continuity: ContinuityLifecycleState.notReady,
    );
    _useTallViewport(tester);
    await tester.pumpWidget(
      _screen(
        role: 'CASHIER',
        getRefund: (_) async => _detail(
          approvalStatus: 'APPROVED',
          allowedRails: const ['offline_electronic'],
          workflowStatus: 'ready_for_payout',
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      tester
          .widget<FilledButton>(
            find.byKey(
              const ValueKey('counter-sale-refund-pay-offline-electronic'),
            ),
          )
          .onPressed,
      isNull,
    );
  });
}
