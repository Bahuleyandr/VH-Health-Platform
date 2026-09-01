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
    'lists and loads medication credit notes from the billing surface',
    () async {
      final captured = <http.Request>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured.add(request);
          final data = request.url.path.endsWith('/credit-notes/42')
              ? {'id': 42, 'status': 'pending'}
              : [
                  {'id': 42, 'status': 'pending'},
                ];
          return http.Response(
            jsonEncode({'success': true, 'data': data}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final notes = await BillingApiService.listMedicationCreditNotes(
        status: 'PENDING',
      );
      final detail = await BillingApiService.getMedicationCreditNote('42');

      expect(notes.single['id'], 42);
      expect(detail['status'], 'pending');
      expect(captured[0].method, 'GET');
      expect(captured[0].url.path, endsWith('/billing/v2/credit-notes'));
      expect(captured[0].url.queryParameters['status'], 'pending');
      expect(captured[1].url.path, endsWith('/billing/v2/credit-notes/42'));
    },
  );

  test(
    'credit-note commands carry exact bodies and idempotency keys',
    () async {
      final captured = <http.Request>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured.add(request);
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 42},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      await BillingApiService.approveMedicationCreditNote(
        creditNoteId: '42',
        idempotencyKey: 'approve-42',
      );
      await BillingApiService.rejectMedicationCreditNote(
        creditNoteId: '42',
        rejectionReason: '  Invalid original return evidence  ',
        idempotencyKey: 'reject-42',
      );
      await BillingApiService.applyMedicationCreditNote(
        creditNoteId: '42',
        refundMode: 'upi',
        idempotencyKey: 'apply-42',
      );

      expect(captured.map((request) => request.method), everyElement('POST'));
      expect(captured[0].headers['idempotency-key'], 'approve-42');
      expect(jsonDecode(captured[0].body), <String, dynamic>{});
      expect(captured[1].headers['idempotency-key'], 'reject-42');
      expect(jsonDecode(captured[1].body), {
        'rejection_reason': 'Invalid original return evidence',
      });
      expect(captured[2].headers['idempotency-key'], 'apply-42');
      expect(jsonDecode(captured[2].body), {'refund_mode': 'UPI'});
    },
  );

  test(
    'refund approval, manual evidence, and gateway initiation stay separate',
    () async {
      final captured = <http.Request>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured.add(request);
          final data = request.method == 'GET'
              ? [
                  {'gateway_order_id': 91, 'refundable_amount': '25.00'},
                ]
              : {'id': 7};
          return http.Response(
            jsonEncode({'success': true, 'data': data}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      await BillingApiService.approveRefund(
        7,
        idempotencyKey: 'approve-refund-7',
      );
      await BillingApiService.markRefundPaid(
        refundId: 7,
        reference: '  CASH-VOUCHER-7  ',
        idempotencyKey: 'manual-pay-7',
      );
      final candidates = await BillingApiService.listGatewayRefundCandidates(7);
      await BillingApiService.initiateGatewayRefund(
        refundId: 7,
        gatewayOrderId: 91,
        idempotencyKey: 'gateway-refund-7',
      );

      expect(captured[0].url.path, endsWith('/billing/v2/refunds/7/approve'));
      expect(captured[0].headers['idempotency-key'], 'approve-refund-7');
      expect(captured[1].url.path, endsWith('/billing/v2/refunds/7/pay'));
      expect(captured[1].headers['idempotency-key'], 'manual-pay-7');
      expect(jsonDecode(captured[1].body), {'reference': 'CASH-VOUCHER-7'});
      expect(
        captured[2].url.path,
        endsWith('/billing/gateway/refunds/7/candidates'),
      );
      expect(candidates.single['gateway_order_id'], 91);
      expect(captured[3].url.path, endsWith('/billing/gateway/refunds'));
      expect(captured[3].headers['idempotency-key'], 'gateway-refund-7');
      expect(jsonDecode(captured[3].body), {
        'billing_refund_id': 7,
        'gateway_order_id': 91,
      });
    },
  );
}
