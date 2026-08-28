import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/billing_api_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  test(
    'loads the exact refund and filters by both workflow identifiers',
    () async {
      final captured = <http.Request>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured.add(request);
          final data = request.url.path.endsWith('/refunds/7')
              ? {
                  'refund': {'id': 7, 'counter_sale_void_request_id': 17},
                  'void_request': {'id': 17, 'refund_id': 7},
                  'allowed_payout_rails': ['offline_electronic'],
                }
              : [
                  {'id': 7, 'counter_sale_void_request_id': 17},
                ];
          return http.Response(
            jsonEncode({'success': true, 'data': data}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final detail = await BillingApiService.getRefund(7);
      final rows = await BillingApiService.listRefunds(
        refundId: 7,
        counterSaleVoidRequestId: ' 17 ',
      );

      expect(detail['void_request']['id'], 17);
      expect(rows.single['id'], 7);
      expect(captured[0].url.path, endsWith('/billing/v2/refunds/7'));
      expect(captured[0].url.query, isEmpty);
      expect(captured[1].url.path, endsWith('/billing/v2/refunds'));
      expect(captured[1].url.queryParameters, {
        'id': '7',
        'counter_sale_void_request_id': '17',
      });
    },
  );

  test(
    'keeps approval and all three payout rails as distinct commands',
    () async {
      final captured = <http.Request>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured.add(request);
          final data = request.method == 'GET'
              ? [
                  {'gateway_order_id': 91},
                ]
              : {'id': 7};
          return http.Response(
            jsonEncode({'success': true, 'data': data}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      await BillingApiService.approveRefund(7, idempotencyKey: 'approve-7');
      await BillingApiService.markRefundPaid(
        refundId: 7,
        reference: ' CASH-VOUCHER-7 ',
        cashDrawerSessionId: ' 81 ',
        idempotencyKey: 'cash-7',
      );
      await BillingApiService.markOfflineElectronicRefundPaid(
        refundId: 7,
        originalPaymentReference: ' UPI-ORIGINAL-7 ',
        providerName: ' Acquirer ',
        providerRefundReference: ' PROVIDER-REFUND-7 ',
        providerRefundedAt: DateTime.parse('2026-08-28T10:30:00+05:30'),
        idempotencyKey: 'offline-electronic-7',
      );
      final candidates = await BillingApiService.listGatewayRefundCandidates(7);
      await BillingApiService.initiateGatewayRefund(
        refundId: 7,
        gatewayOrderId: 91,
        idempotencyKey: 'gateway-7',
      );

      expect(captured[0].url.path, endsWith('/billing/v2/refunds/7/approve'));
      expect(captured[0].headers['Idempotency-Key'], 'approve-7');
      expect(jsonDecode(captured[0].body), <String, dynamic>{});
      expect(captured[1].url.path, endsWith('/billing/v2/refunds/7/pay'));
      expect(captured[1].headers['Idempotency-Key'], 'cash-7');
      expect(jsonDecode(captured[1].body), {
        'reference': 'CASH-VOUCHER-7',
        'cash_drawer_session_id': '81',
      });
      expect(
        captured[2].url.path,
        endsWith('/billing/v2/refunds/7/pay/offline-electronic'),
      );
      expect(captured[2].headers['Idempotency-Key'], 'offline-electronic-7');
      expect(jsonDecode(captured[2].body), {
        'original_payment_reference': 'UPI-ORIGINAL-7',
        'provider_name': 'Acquirer',
        'provider_refund_reference': 'PROVIDER-REFUND-7',
        'provider_refunded_at': '2026-08-28T05:00:00.000Z',
      });
      expect(
        captured[3].url.path,
        endsWith('/billing/gateway/refunds/7/candidates'),
      );
      expect(candidates.single['gateway_order_id'], 91);
      expect(captured[4].url.path, endsWith('/billing/gateway/refunds'));
      expect(captured[4].headers['Idempotency-Key'], 'gateway-7');
      expect(jsonDecode(captured[4].body), {
        'billing_refund_id': 7,
        'gateway_order_id': 91,
      });
    },
  );

  test('open cash drawer lookup is actor-scoped and bounded', () async {
    late http.Request captured;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': [
              {'id': 81, 'status': 'open'},
            ],
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final rows = await BillingApiService.listCashDrawerSessions(
      cashierUid: ' cashier-7 ',
      status: 'OPEN',
      limit: 25,
    );

    expect(rows.single['id'], 81);
    expect(captured.url.path, endsWith('/billing/v2/cash-drawer/sessions'));
    expect(captured.url.queryParameters, {
      'cashier_uid': 'cashier-7',
      'status': 'open',
      'limit': '25',
    });
  });

  test('gateway refund reconciliation exposes the queue and exact terminal command', () async {
    final captured = <http.Request>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured.add(request);
        final data = request.method == 'GET'
            ? {
                'refunds': [
                  {'id': 31, 'status': 'requires_reconciliation'},
                ],
                'limit': 25,
                'offset': 0,
              }
            : {'id': 31, 'status': 'failed'};
        return http.Response(
          jsonEncode({'success': true, 'data': data}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final rows = await BillingApiService.listGatewayRefundReconciliations(
      limit: 25,
    );
    final resolved = await BillingApiService.reconcileGatewayRefund(
      gatewayRefundId: 31,
      disposition: ' PROVIDER_NOT_REFUNDED ',
      evidenceReference: ' CASE-3100 ',
      note: ' Provider confirmed that no refund was issued. ',
    );

    expect(rows.single['id'], 31);
    expect(resolved['status'], 'failed');
    expect(
      captured[0].url.path,
      endsWith('/billing/gateway/refund-reconciliation'),
    );
    expect(captured[0].url.queryParameters, {
      'include_resolved': 'false',
      'limit': '25',
      'offset': '0',
    });
    expect(
      captured[1].url.path,
      endsWith('/billing/gateway/refunds/31/reconcile'),
    );
    expect(jsonDecode(captured[1].body), {
      'disposition': 'provider_not_refunded',
      'evidence_reference': 'CASE-3100',
      'note': 'Provider confirmed that no refund was issued.',
      'recovery_path': 'gateway_retry',
    });
  });
}
