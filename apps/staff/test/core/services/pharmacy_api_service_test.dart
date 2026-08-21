import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/pharmacy_api_service.dart';

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

  test('counter sale transports the two-person approval id, never caller witness identity', () async {
    final sale = <String, dynamic>{
      'lines': [
        {'inventory_item_id': 17, 'quantity': 1.0},
      ],
      'customer_name': 'Walk-in Customer',
      'customer_phone': '9876543210',
      'rx': {'doctor_name': 'Dr Rao', 'reference': 'RX-77'},
      'payment_mode': 'CASH',
    };
    var call = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        call++;
        final body = Map<String, dynamic>.from(jsonDecode(request.body) as Map);
        if (call == 1) {
          expect(
            request.url.path,
            endsWith('/pharmacy-orders/counter-sales/witness-approvals'),
          );
          expect(body, sale);
          expect(
            request.headers['Idempotency-Key'],
            'counter-witness-request:test-1',
          );
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': '71', 'status': 'pending'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        if (call == 2) {
          expect(
            request.url.path,
            endsWith(
              '/pharmacy-orders/counter-sales/witness-approvals/71/approve',
            ),
          );
          expect(body, {
            'sale': sale,
            'employeeId': 'NURSE-002',
            'password': 'witness-secret',
          });
          expect(
            request.headers['Idempotency-Key'],
            'counter-witness-approval:test-1',
          );
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'id': '71',
                'status': 'approved',
                'witness': {'name': 'Canonical Nurse'},
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        expect(request.url.path, endsWith('/pharmacy-orders/counter-sales'));
        expect(body['witness_approval_id'], '71');
        expect(body.containsKey('witness'), isFalse);
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'sale': {'id': '91'},
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await PharmacyApiService.requestCounterSaleWitnessApproval(
      sale: sale,
      idempotencyKey: 'counter-witness-request:test-1',
    );
    await PharmacyApiService.approveCounterSaleWitnessApproval(
      approvalId: '71',
      sale: sale,
      employeeId: 'nurse-002',
      password: 'witness-secret',
      idempotencyKey: 'counter-witness-approval:test-1',
    );
    await PharmacyApiService.createCounterSale(
      lines: List<Map<String, dynamic>>.from(sale['lines'] as List),
      customerName: 'Walk-in Customer',
      customerPhone: '9876543210',
      rx: Map<String, dynamic>.from(sale['rx'] as Map),
      witnessApprovalId: '71',
      paymentMode: 'CASH',
    );

    expect(call, 3);
  });

  test('witness request and approval reuse caller intent keys after a lost response', () async {
    final sale = <String, dynamic>{
      'lines': [
        {'inventory_item_id': 17, 'quantity': 1.0},
      ],
      'customer_name': 'Walk-in Customer',
      'payment_mode': 'CASH',
    };
    final keysByPath = <String, List<String?>>{};
    final attemptsByPath = <String, int>{};
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        final path = request.url.path;
        keysByPath
            .putIfAbsent(path, () => [])
            .add(request.headers['Idempotency-Key']);
        final attempt = (attemptsByPath[path] ?? 0) + 1;
        attemptsByPath[path] = attempt;
        if (attempt == 1) {
          throw http.ClientException('response lost after durable write');
        }
        final isApproval = path.endsWith('/approve');
        return http.Response(
          jsonEncode({
            'success': true,
            'data': isApproval
                ? {
                    'id': '71',
                    'status': 'approved',
                    'witness': {'name': 'Canonical Nurse'},
                  }
                : {'id': '71', 'status': 'pending'},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await PharmacyApiService.requestCounterSaleWitnessApproval(
      sale: sale,
      idempotencyKey: 'counter-witness-request:lost-response',
    );
    await PharmacyApiService.approveCounterSaleWitnessApproval(
      approvalId: '71',
      sale: sale,
      employeeId: 'NURSE-002',
      password: 'witness-secret',
      idempotencyKey: 'counter-witness-approval:lost-response',
    );

    final requestPath = keysByPath.keys.singleWhere(
      (path) => path.endsWith('/counter-sales/witness-approvals'),
    );
    final approvalPath = keysByPath.keys.singleWhere(
      (path) => path.endsWith('/witness-approvals/71/approve'),
    );
    expect(keysByPath[requestPath], [
      'counter-witness-request:lost-response',
      'counter-witness-request:lost-response',
    ]);
    expect(keysByPath[approvalPath], [
      'counter-witness-approval:lost-response',
      'counter-witness-approval:lost-response',
    ]);
  });
}
