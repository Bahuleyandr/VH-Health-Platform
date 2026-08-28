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
        expect(
          request.headers['Idempotency-Key'],
          'counter-sale-create:test-1',
        );
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
      idempotencyKey: 'counter-sale-create:test-1',
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

  test('inventory lookup carries an exact catalog link', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, endsWith('/pharmacy/inventory/v2/items'));
        expect(request.url.queryParameters, {
          'status': 'active',
          'catalog_id': '17',
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': [
              {'id': 501, 'catalog_id': 17, 'display_name': 'Morphine'},
            ],
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final rows = await PharmacyApiService.getInventoryItems(
      status: 'active',
      catalogId: 17,
    );
    expect(rows.single['id'], 501);
  });

  test(
    'ward indent reads and mutations use the canonical route family',
    () async {
      var call = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          call++;
          if (call == 1) {
            expect(request.method, 'GET');
            expect(request.url.path, endsWith('/pharmacy-orders/ward-indents'));
            expect(request.url.queryParameters, {
              'ward_id': '8',
              'status': 'requested',
              'overdue_only': 'true',
              'limit': '25',
            });
            return http.Response(
              jsonEncode({
                'success': true,
                'data': [
                  {'id': 73, 'status': 'requested', 'state_version': 1},
                ],
              }),
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          if (call == 2) {
            expect(request.method, 'GET');
            expect(
              request.url.path,
              endsWith('/pharmacy-orders/ward-indents/73'),
            );
            return http.Response(
              jsonEncode({
                'success': true,
                'data': {'id': 73, 'status': 'requested', 'state_version': 1},
              }),
              200,
              headers: {'content-type': 'application/json'},
            );
          }

          expect(request.method, 'POST');
          expect(
            request.url.path,
            endsWith('/pharmacy-orders/ward-indents/73/short-supply'),
          );
          expect(request.headers['Idempotency-Key'], 'ward-indent:intent-73');
          expect(jsonDecode(request.body), {
            'expected_version': 1,
            'reason': 'One line unavailable',
            'item_quantities_available': [
              {'item_id': 91, 'quantity_available': 1.0},
            ],
          });
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 73, 'status': 'short_supply', 'state_version': 2},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final rows = await PharmacyApiService.listWardIndents(
        wardId: 8,
        status: 'requested',
        overdueOnly: true,
        limit: 25,
      );
      final detail = await PharmacyApiService.getWardIndent(73);
      final mutated = await PharmacyApiService.mutateWardIndent(
        73,
        actionPath: 'short-supply',
        expectedVersion: 1,
        payload: {
          'reason': 'One line unavailable',
          'item_quantities_available': [
            {'item_id': 91, 'quantity_available': 1.0},
          ],
        },
        idempotencyKey: 'ward-indent:intent-73',
      );

      expect(rows.single['id'], 73);
      expect(detail['state_version'], 1);
      expect(mutated['status'], 'short_supply');
      expect(call, 3);
    },
  );

  test('ward indent pages preserve the backend keyset cursor', () async {
    final cursor = DateTime.utc(2026, 8, 27, 10, 30);
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, endsWith('/pharmacy-orders/ward-indents'));
        expect(request.url.queryParameters, {
          'worklist': 'open',
          'before_requested_at': cursor.toIso8601String(),
          'before_id': '73',
          'limit': '100',
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': [
              {'id': 72, 'status': 'requested', 'state_version': 1},
            ],
            'meta': {
              'pagination': {
                'has_more': true,
                'limit': 100,
                'before_requested_at': '2026-08-27T09:30:00.000Z',
                'before_id': 72,
              },
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final page = await PharmacyApiService.listWardIndentPage(
      worklist: 'open',
      beforeRequestedAt: cursor,
      beforeId: 73,
    );

    expect(page.items.single['id'], 72);
    expect(page.hasMore, isTrue);
    expect(page.nextBeforeRequestedAt, DateTime.utc(2026, 8, 27, 9, 30));
    expect(page.nextBeforeId, 72);
  });

  test('controlled ward handoff transports exact witnessed evidence', () async {
    final dispense = <String, dynamic>{
      'inventory_item_id': 17,
      'inventory_batch_id': 27,
      'quantity': 2.0,
      'patient_uid': '11111111-1111-4111-8111-111111111111',
      'prescription_number': 'WI-2026-0073',
      'reference_id': 'ward-indent:73:item:91',
    };
    var call = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        call++;
        final body = Map<String, dynamic>.from(jsonDecode(request.body) as Map);
        if (call == 1) {
          expect(
            request.url.path,
            endsWith(
              '/pharmacy/inventory/v2/controlled-dispense/witness-approvals',
            ),
          );
          expect(request.headers['Idempotency-Key'], 'ward-witness-request:91');
          expect(body, dispense);
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 'approval-91', 'status': 'pending'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        if (call == 2) {
          expect(
            request.url.path,
            endsWith(
              '/pharmacy/inventory/v2/controlled-dispense/witness-approvals/approval-91/approve',
            ),
          );
          expect(request.headers['Idempotency-Key'], 'ward-witness-approve:91');
          expect(body, {
            'dispense': dispense,
            'employeeId': 'NURSE-002',
            'password': 'witness-secret',
          });
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 'approval-91', 'status': 'approved'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        if (call == 3) {
          expect(
            request.url.path,
            endsWith('/pharmacy/inventory/v2/controlled-dispense'),
          );
          expect(request.headers['Idempotency-Key'], 'ward-dispense:91');
          expect(body['witness_approval_id'], 'approval-91');
          expect(body['reference_id'], 'ward-indent:73:item:91');
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'movement': {'id': 701},
                'register_entry': {'id': 801},
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }

        expect(
          request.url.path,
          endsWith('/pharmacy-orders/ward-indents/73/controlled-handoff'),
        );
        expect(request.headers['Idempotency-Key'], 'ward-handoff:73');
        expect(body, {
          'expected_version': 4,
          'item_evidence': [
            {'item_id': 91, 'movement_id': 701, 'register_id': 801},
          ],
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'id': 73, 'status': 'approved', 'state_version': 5},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await PharmacyApiService.requestControlledDispenseWitnessApproval(
      dispense: dispense,
      idempotencyKey: 'ward-witness-request:91',
    );
    await PharmacyApiService.approveControlledDispenseWitnessApproval(
      approvalId: 'approval-91',
      dispense: dispense,
      employeeId: 'nurse-002',
      password: 'witness-secret',
      idempotencyKey: 'ward-witness-approve:91',
    );
    final evidence = await PharmacyApiService.dispenseControlledInventory(
      dispense: {...dispense, 'witness_approval_id': 'approval-91'},
      idempotencyKey: 'ward-dispense:91',
    );
    await PharmacyApiService.mutateWardIndent(
      73,
      actionPath: 'controlled-handoff',
      expectedVersion: 4,
      payload: {
        'item_evidence': [
          {
            'item_id': 91,
            'movement_id': evidence['movement']['id'],
            'register_id': evidence['register_entry']['id'],
          },
        ],
      },
      idempotencyKey: 'ward-handoff:73',
    );

    expect(call, 4);
  });

  test(
    'ward-indent candidate lookup uses the exact indent item endpoint',
    () async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.method, 'GET');
          expect(
            request.url.path,
            endsWith(
              '/pharmacy-orders/ward-indents/73/items/91/inventory-candidates',
            ),
          );
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'candidates': [
                  {
                    'id': 501,
                    'catalog_id': 17,
                    'facility_id': 8,
                    'unreserved_quantity': 2,
                  },
                ],
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final rows = await PharmacyApiService.getWardIndentInventoryCandidates(
        73,
        91,
      );

      expect(rows.single['id'], 501);
      expect(rows.single['facility_id'], 8);
    },
  );

  test('controlled return records exact movement evidence contract', () async {
    late http.Request captured;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'movement': {'id': 811},
              'register_entry': {'id': 911, 'movement_kind': 'return'},
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    const movement = <String, dynamic>{
      'inventory_item_id': 501,
      'inventory_batch_id': 601,
      'catalog_id': 17,
      'movement_kind': 'return',
      'quantity': 2,
      'reference_type': 'ward_indent_return',
      'reference_id': 'ward-indent:73:item:91',
      'patient_uid': '11111111-1111-4111-8111-111111111111',
    };

    final result = await PharmacyApiService.recordInventoryMovement(
      movement: movement,
      idempotencyKey: 'ward-indent-return:test',
    );

    expect(result['movement']['id'], 811);
    expect(result['register_entry']['movement_kind'], 'return');
    expect(captured.method, 'POST');
    expect(captured.url.path, endsWith('/pharmacy/inventory/v2/movements'));
    expect(captured.headers['Idempotency-Key'], 'ward-indent-return:test');
    expect(jsonDecode(captured.body), movement);
  });

  test('counter-sale create and void closure commands carry exact protected contracts', () async {
    final captured = <http.Request>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured.add(request);
        return http.Response(
          jsonEncode({
            'success': true,
            'data': request.method == 'GET'
                ? {
                    'workflow_status': 'REFUND_REJECTED_REVIEW',
                    'sale': {'id': 91, 'status': 'VOID_PENDING_REFUND'},
                  }
                : {
                    'sale': {'id': 91, 'status': 'VOID_PENDING_REFUND'},
                  },
          }),
          request.url.path.endsWith('/void') ? 202 : 200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await PharmacyApiService.createCounterSale(
      lines: const [
        {'inventory_item_id': 17, 'quantity': 1},
      ],
      customerName: 'Walk-in Customer',
      paymentMode: 'UPI',
      paymentReference: ' UPI-ORIGINAL-91 ',
      idempotencyKey: 'counter-sale-create:91',
    );
    await PharmacyApiService.voidCounterSale(
      '91',
      ' Wrong item selected ',
      disposition: 'never_handed_over',
      idempotencyKey: 'counter-sale-void:91',
    );
    await PharmacyApiService.getCounterSaleVoidStatus('91');
    await PharmacyApiService.reconcileCounterSaleVoid(
      '91',
      idempotencyKey: 'counter-sale-reconcile:91',
    );
    await PharmacyApiService.resolveRejectedCounterSaleVoid(
      '91',
      reason: ' Customer received medication ',
      idempotencyKey: 'counter-sale-handover:91',
    );

    expect(captured, hasLength(5));
    expect(captured[0].url.path, endsWith('/pharmacy-orders/counter-sales'));
    expect(captured[0].headers['Idempotency-Key'], 'counter-sale-create:91');
    expect(
      jsonDecode(captured[0].body)['payment_reference'],
      'UPI-ORIGINAL-91',
    );
    expect(
      captured[1].url.path,
      endsWith('/pharmacy-orders/counter-sales/91/void'),
    );
    expect(captured[1].headers['Idempotency-Key'], 'counter-sale-void:91');
    expect(jsonDecode(captured[1].body), {
      'reason': 'Wrong item selected',
      'disposition': 'NEVER_HANDED_OVER',
    });
    expect(captured[2].method, 'GET');
    expect(
      captured[2].url.path,
      endsWith('/pharmacy-orders/counter-sales/91/void-status'),
    );
    expect(
      captured[3].url.path,
      endsWith('/pharmacy-orders/counter-sales/91/void/reconcile'),
    );
    expect(captured[3].headers['Idempotency-Key'], 'counter-sale-reconcile:91');
    expect(jsonDecode(captured[3].body), <String, dynamic>{});
    expect(
      captured[4].url.path,
      endsWith('/pharmacy-orders/counter-sales/91/void/rejection/resolve'),
    );
    expect(captured[4].headers['Idempotency-Key'], 'counter-sale-handover:91');
    expect(jsonDecode(captured[4].body), {
      'resolution': 'CUSTOMER_HANDOVER_CONFIRMED',
      'reason': 'Customer received medication',
    });
  });
}
