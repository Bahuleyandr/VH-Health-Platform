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
      'facility_id': 8,
      'lines': [
        {
          'inventory_item_id': 17,
          'quantity': 1.0,
          'prescription_line_index': 0,
        },
      ],
      'patient_uid': '11111111-1111-4111-8111-111111111111',
      'rx': {'prescription_id': 77},
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
      facilityId: 8,
      lines: List<Map<String, dynamic>>.from(sale['lines'] as List),
      patientUid: '11111111-1111-4111-8111-111111111111',
      rx: Map<String, dynamic>.from(sale['rx'] as Map),
      witnessApprovalId: '71',
      paymentMode: 'CASH',
      idempotencyKey: 'counter-sale-create:test-1',
    );

    expect(call, 3);
  });

  test('witness request and approval reuse caller intent keys after a lost response', () async {
    final sale = <String, dynamic>{
      'facility_id': 8,
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
    'substitution dispense transports origin linkage and caller command key',
    () async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.method, 'POST');
          expect(
            request.url.path,
            endsWith('/pharmacy-orders/dispense-substitution'),
          );
          expect(
            request.headers['Idempotency-Key'],
            'substitution:order-7:rx-77',
          );
          expect(jsonDecode(request.body), {
            'order_id': 7,
            'prescription_id': 77,
            'order_line_index': 0,
            'prescription_line_index': 0,
            'patient_uid': '11111111-1111-4111-8111-111111111111',
            'inventory_item_id': 55,
            'inventory_batch_id': 900,
            'quantity': 2,
            'original_catalog_id': 101,
            'final_catalog_id': 202,
            'reason': 'Original unavailable',
            'payment_mode': 'cash',
            'amount_collected': 40,
          });
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'movement_id': 501, 'remaining_quantity': 3},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final result = await PharmacyApiService.dispenseSubstitution(
        orderId: 7,
        prescriptionId: 77,
        orderLineIndex: 0,
        prescriptionLineIndex: 0,
        patientUid: '11111111-1111-4111-8111-111111111111',
        inventoryItemId: 55,
        inventoryBatchId: 900,
        quantity: 2,
        originalCatalogId: 101,
        finalCatalogId: 202,
        reason: 'Original unavailable',
        paymentMode: 'cash',
        amountCollected: 40,
        idempotencyKey: 'substitution:order-7:rx-77',
      );

      expect(result['movement_id'], 501);
      expect(result['remaining_quantity'], 3);
    },
  );

  test('substitution dispense preserves typed recovery errors', () async {
    VHHttpClient.setClientForTesting(
      MockClient(
        (request) async => http.Response(
          jsonEncode({
            'success': false,
            'message': 'Pharmacist verification is required',
            'code': 'PHARMACY_VERIFICATION_REQUIRED',
            'details': {
              'clinical_verification_status': 'pending',
              'verify_endpoint': '/api/v1/pharmacy/orders/7/verify',
            },
          }),
          409,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );

    await expectLater(
      PharmacyApiService.dispenseSubstitution(
        orderId: 7,
        prescriptionId: 77,
        orderLineIndex: 0,
        prescriptionLineIndex: 0,
        patientUid: '11111111-1111-4111-8111-111111111111',
        inventoryItemId: 55,
        inventoryBatchId: 900,
        quantity: 2,
        originalCatalogId: 101,
        finalCatalogId: 202,
        paymentMode: 'cash',
        amountCollected: 40,
        idempotencyKey: 'substitution:typed-error',
      ),
      throwsA(
        isA<PharmacyApiException>()
            .having((error) => error.statusCode, 'statusCode', 409)
            .having(
              (error) => error.code,
              'code',
              'PHARMACY_VERIFICATION_REQUIRED',
            )
            .having((error) => error.details, 'details', {
              'clinical_verification_status': 'pending',
              'verify_endpoint': '/api/v1/pharmacy/orders/7/verify',
            }),
      ),
    );
  });

  test(
    'substitution witness request preserves typed recovery errors',
    () async {
      VHHttpClient.setClientForTesting(
        MockClient(
          (request) async => http.Response(
            jsonEncode({
              'success': false,
              'message': 'Witness approval already exists',
              'code': 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_CONFLICT',
              'details': {'approval_id': 41},
            }),
            409,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );

      await expectLater(
        PharmacyApiService.requestSubstitutionWitnessApproval(
          substitution: const {
            'order_id': 7,
            'prescription_id': 77,
            'inventory_item_id': 55,
            'inventory_batch_id': 900,
            'quantity': 2,
            'original_catalog_id': 101,
            'final_catalog_id': 202,
          },
          idempotencyKey: 'substitution:witness-request',
        ),
        throwsA(
          isA<PharmacyApiException>()
              .having((error) => error.statusCode, 'statusCode', 409)
              .having(
                (error) => error.code,
                'code',
                'CONTROLLED_DISPENSE_WITNESS_APPROVAL_CONFLICT',
              )
              .having((error) => error.details, 'details', {'approval_id': 41}),
        ),
      );
    },
  );

  test(
    'substitution witness approval preserves typed credential errors',
    () async {
      VHHttpClient.setClientForTesting(
        MockClient(
          (request) async => http.Response(
            jsonEncode({
              'success': false,
              'message': 'Witness credentials invalid',
              'code': 'CONTROLLED_DISPENSE_WITNESS_CREDENTIALS_INVALID',
              'details': {'remaining_attempts': 2},
            }),
            401,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );

      await expectLater(
        PharmacyApiService.approveSubstitutionWitnessApproval(
          approvalId: '41',
          substitution: const {
            'order_id': 7,
            'prescription_id': 77,
            'inventory_item_id': 55,
            'inventory_batch_id': 900,
            'quantity': 2,
            'original_catalog_id': 101,
            'final_catalog_id': 202,
          },
          employeeId: 'emp-9',
          password: 'secret',
          idempotencyKey: 'substitution:witness-approve',
        ),
        throwsA(
          isA<PharmacyApiException>()
              .having((error) => error.statusCode, 'statusCode', 401)
              .having(
                (error) => error.code,
                'code',
                'CONTROLLED_DISPENSE_WITNESS_CREDENTIALS_INVALID',
              )
              .having((error) => error.details, 'details', {
                'remaining_attempts': 2,
              }),
        ),
      );
    },
  );

  test(
    'ward indent create keeps admission linkage and stable intent key',
    () async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, endsWith('/pharmacy-orders/ward-indents'));
          expect(
            request.headers['Idempotency-Key'],
            'ward-indent:create:admission-44',
          );
          expect(jsonDecode(request.body), {
            'ward_id': 8,
            'admission_id': 44,
            'encounter_id': '22222222-2222-4222-8222-222222222222',
            'patient_uid': '11111111-1111-4111-8111-111111111111',
            'indent_type': 'pharmacy',
            'items': [
              {
                'pharmacy_catalog_id': 17,
                'clinical_order_id': 71,
                'quantity_requested': 2,
                'unit': 'tablet',
              },
            ],
            'notes': 'Night dose',
          });
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 73, 'status': 'requested'},
            }),
            201,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final result = await PharmacyApiService.createWardIndent(
        wardId: 8,
        admissionId: 44,
        encounterId: '22222222-2222-4222-8222-222222222222',
        patientUid: '11111111-1111-4111-8111-111111111111',
        items: const [
          {
            'pharmacy_catalog_id': 17,
            'clinical_order_id': 71,
            'quantity_requested': 2,
            'unit': 'tablet',
          },
        ],
        notes: 'Night dose',
        idempotencyKey: 'ward-indent:create:admission-44',
      );

      expect(result['id'], 73);
      expect(result['status'], 'requested');
    },
  );

  test(
    'ward indent create preserves typed conflict recovery evidence',
    () async {
      VHHttpClient.setClientForTesting(
        MockClient(
          (request) async => http.Response(
            jsonEncode({
              'success': false,
              'message': 'Clinical order already has a ward indent',
              'code': 'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED',
              'details': {
                'ward_indent_id': 73,
                'expected_catalog_id': 17,
                'expected_quantity': 1,
                'expected_unit': 'tablet',
              },
            }),
            409,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );

      await expectLater(
        PharmacyApiService.createWardIndent(
          admissionId: 44,
          items: const [
            {'clinical_order_id': 71, 'quantity_requested': 1},
          ],
          idempotencyKey: 'ward-indent:create:conflict',
        ),
        throwsA(
          isA<PharmacyApiException>()
              .having((error) => error.statusCode, 'statusCode', 409)
              .having(
                (error) => error.code,
                'code',
                'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED',
              )
              .having((error) => error.details, 'details', {
                'ward_indent_id': 73,
                'expected_catalog_id': 17,
                'expected_quantity': 1,
                'expected_unit': 'tablet',
              }),
        ),
      );
    },
  );

  test(
    'delivery rotates the command key after a correctable typed failure',
    () async {
      final keys = <String?>[];
      var call = 0;
      const token = 'patient-handoff-token-91';
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          call++;
          keys.add(request.headers['Idempotency-Key']);
          expect(
            request.url.path,
            endsWith('/pharmacy-orders/orders/91/delivered'),
          );
          expect(jsonDecode(request.body), {'handoff_token': token});
          if (call == 1) {
            return http.Response(
              jsonEncode({
                'success': false,
                'message': 'Delivery state must be refreshed',
                'code': 'PHARMACY_ORDER_STATUS_CHANGED',
              }),
              409,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 91, 'status': 'DELIVERED'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      await expectLater(
        PharmacyApiService.completePharmacyDelivery(
          91,
          handoffToken: token,
        ),
        throwsA(
          isA<PharmacyApiException>().having(
            (error) => error.statusCode,
            'statusCode',
            409,
          ),
        ),
      );
      final result = await PharmacyApiService.completePharmacyDelivery(
        91,
        handoffToken: token,
      );

      expect(result['status'], 'DELIVERED');
      expect(keys, hasLength(2));
      expect(keys.first, isNotNull);
      expect(keys.last, isNot(keys.first));
    },
  );

  test(
    'ambiguous delivery failure preserves exact token command identity',
    () async {
      final keys = <String?>[];
      final bodies = <String>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          keys.add(request.headers['Idempotency-Key']);
          bodies.add(request.body);
          return http.Response(
            jsonEncode({
              'success': false,
              'message': 'Upstream result is unknown',
              'code': 'PHARMACY_DELIVERY_OUTCOME_UNKNOWN',
            }),
            503,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      for (var retry = 0; retry < 2; retry++) {
        await expectLater(
          PharmacyApiService.completePharmacyDelivery(
            94,
            handoffToken: 'patient-handoff-token-94',
          ),
          throwsA(isA<PharmacyApiException>()),
        );
      }

      expect(keys, hasLength(2));
      expect(keys.first, keys.last);
      expect(bodies.first, bodies.last);
    },
  );

  test('delivery custody commands use canonical governed endpoints', () async {
    final paths = <String>[];
    final bodies = <Map<String, dynamic>>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        paths.add(request.url.path);
        bodies.add(Map<String, dynamic>.from(jsonDecode(request.body) as Map));
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'id': 95},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await PharmacyApiService.reissuePharmacyDeliveryHandoff(
      95,
      reason: 'Patient requested a new one-time handoff token',
    );
    await PharmacyApiService.requestPharmacyDeliveryReturn(
      95,
      reason: 'Patient declined delivery after dispatch confirmation',
    );
    await PharmacyApiService.completePharmacyDeliveryReturn(
      95,
      disposition: 'quarantined',
      reason: 'Cold-chain integrity requires pharmacist quarantine review',
    );

    expect(paths, [
      endsWith('/pharmacy-orders/orders/95/delivery-handoff/reissue'),
      endsWith('/pharmacy-orders/orders/95/delivery-return/request'),
      endsWith('/pharmacy-orders/orders/95/delivery-return/complete'),
    ]);
    expect(bodies[0], {
      'reason': 'Patient requested a new one-time handoff token',
    });
    expect(bodies[1], {
      'reason': 'Patient declined delivery after dispatch confirmation',
    });
    expect(bodies[2], {
      'disposition': 'quarantined',
      'reason': 'Cold-chain integrity requires pharmacist quarantine review',
    });
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

  test('counter-sale item search is scoped to the explicit facility', () async {
    late http.Request captured;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'items': [
                {'id': 17, 'facility_id': 8, 'display_name': 'Morphine 10'},
              ],
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final items = await PharmacyApiService.getCounterSaleItems(
      facilityId: 8,
      search: ' morphine ',
    );

    expect(captured.url.path, endsWith('/pharmacy-orders/counter-sales/items'));
    expect(captured.url.queryParameters, {'facility_id': '8', 'q': 'morphine'});
    expect(items.single['facility_id'], 8);
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
      facilityId: 8,
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
    expect(jsonDecode(captured[0].body)['facility_id'], 8);
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

  test('legacy line recovery transports explicit zero-based mappings without catalog inference', () async {
    late http.Request captured;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'id': 91, 'line_identity_recovery_required': false},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final result = await PharmacyApiService.resolvePharmacyOrderLineIdentities(
      91,
      lineMappings: const [
        {'order_line_index': 0, 'prescription_line_index': 1},
        {'order_line_index': 1, 'prescription_line_index': 0},
      ],
    );

    expect(
      captured.url.path,
      endsWith('/pharmacy-orders/orders/91/resolve-line-identities'),
    );
    expect(captured.headers['Idempotency-Key'], isNotEmpty);
    expect(jsonDecode(captured.body), {
      'line_mappings': [
        {'order_line_index': 0, 'prescription_line_index': 1},
        {'order_line_index': 1, 'prescription_line_index': 0},
      ],
    });
    expect(result['line_identity_recovery_required'], isFalse);
  });

  test(
    'verification transports verified, override, and rejected decisions',
    () async {
      final requests = <http.Request>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          requests.add(request);
          final body = Map<String, dynamic>.from(
            jsonDecode(request.body) as Map,
          );
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'id': 91,
                'clinical_verification_status': body['decision'],
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      await PharmacyApiService.verifyPharmacyOrder(
        91,
        decision: 'verified',
        notes: 'Formulation and active therapy checked',
      );
      await PharmacyApiService.verifyPharmacyOrder(
        91,
        decision: 'override',
        overrideReason: 'Prescriber confirmed the clinical exception',
        manualAllergyReviewCompleted: true,
      );
      await PharmacyApiService.verifyPharmacyOrder(
        91,
        decision: 'rejected',
        notes: 'Unsafe duplicate therapy',
      );

      expect(requests, hasLength(3));
      for (final request in requests) {
        expect(request.url.path, endsWith('/pharmacy-orders/orders/91/verify'));
        expect(request.headers['Idempotency-Key'], isNotEmpty);
      }
      expect(jsonDecode(requests[0].body), {
        'decision': 'verified',
        'notes': 'Formulation and active therapy checked',
      });
      expect(jsonDecode(requests[1].body), {
        'decision': 'override',
        'override_reason': 'Prescriber confirmed the clinical exception',
        'manual_allergy_review_completed': true,
      });
      expect(jsonDecode(requests[2].body), {
        'decision': 'rejected',
        'notes': 'Unsafe duplicate therapy',
      });
    },
  );

  for (final paymentMode in const ['insurance', 'corporate_tpa']) {
    test(
      'counter dispense preserves exact $paymentMode funding reference and typed next action',
      () async {
        late http.Request captured;
        VHHttpClient.setClientForTesting(
          MockClient((request) async {
            captured = request;
            return http.Response(
              jsonEncode({
                'success': false,
                'message': 'Exact claim allocation is required',
                'code': 'PHARMACY_TPA_FUNDING_REQUIRED',
                'details': {'next_action': 'select_exact_tpa_claim_allocation'},
              }),
              409,
              headers: {'content-type': 'application/json'},
            );
          }),
        );

        await expectLater(
          PharmacyApiService.markPharmacyCounterDispensed(91, {
            'payment_mode': paymentMode,
            'amount_collected': 0,
            'tpa_reference': 'TPA-APPROVED-00091',
          }),
          throwsA(
            isA<PharmacyApiException>()
                .having(
                  (error) => error.code,
                  'code',
                  'PHARMACY_TPA_FUNDING_REQUIRED',
                )
                .having(
                  (error) => error.details?['next_action'],
                  'next_action',
                  'select_exact_tpa_claim_allocation',
                ),
          ),
        );

        expect(
          captured.url.path,
          endsWith('/pharmacy-orders/orders/91/dispense-counter'),
        );
        expect(captured.headers['Idempotency-Key'], isNotEmpty);
        expect(jsonDecode(captured.body), {
          'payment_mode': paymentMode,
          'amount_collected': 0,
          'tpa_reference': 'TPA-APPROVED-00091',
        });
      },
    );

    test(
      'substitution preserves exact $paymentMode funding reference and stable line zero',
      () async {
        late http.Request captured;
        VHHttpClient.setClientForTesting(
          MockClient((request) async {
            captured = request;
            return http.Response(
              jsonEncode({
                'success': true,
                'data': {'movement_id': 501},
              }),
              200,
              headers: {'content-type': 'application/json'},
            );
          }),
        );

        await PharmacyApiService.dispenseSubstitution(
          orderId: 91,
          prescriptionId: 77,
          orderLineIndex: 0,
          prescriptionLineIndex: 0,
          patientUid: '11111111-1111-4111-8111-111111111111',
          inventoryItemId: 55,
          inventoryBatchId: 900,
          quantity: 1,
          originalCatalogId: 101,
          finalCatalogId: 202,
          paymentMode: paymentMode,
          amountCollected: 0,
          tpaReference: 'TPA-APPROVED-00091',
          idempotencyKey: 'substitution:$paymentMode:91:0',
        );

        expect(
          captured.headers['Idempotency-Key'],
          'substitution:$paymentMode:91:0',
        );
        expect(jsonDecode(captured.body), {
          'order_id': 91,
          'prescription_id': 77,
          'order_line_index': 0,
          'prescription_line_index': 0,
          'patient_uid': '11111111-1111-4111-8111-111111111111',
          'inventory_item_id': 55,
          'inventory_batch_id': 900,
          'quantity': 1,
          'original_catalog_id': 101,
          'final_catalog_id': 202,
          'payment_mode': paymentMode,
          'amount_collected': 0,
          'tpa_reference': 'TPA-APPROVED-00091',
        });
      },
    );
  }

  test('every order lifecycle mutation sends a stable idempotency key and exact body', () async {
    final requests = <http.Request>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        requests.add(request);
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'id': 301, 'status': 'CONFIRMED'},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await PharmacyApiService.confirmPharmacyOrder(301, const {
      'confirmation_notes': 'Catalog checked',
    });
    await PharmacyApiService.markPharmacyPreparing(302);
    await PharmacyApiService.dispatchPharmacyOrder(303, const {
      'delivery_assignee_uid': '11111111-1111-4111-8111-111111111111',
    });
    await PharmacyApiService.markPharmacyUnavailable(
      304,
      reason: 'Authoritative batch stock unavailable',
    );
    await PharmacyApiService.cancelPharmacyOrder(
      305,
      'Patient requested cancellation',
    );

    expect(requests, hasLength(5));
    for (final request in requests) {
      expect(request.headers['Idempotency-Key'], isNotEmpty);
    }
    expect(requests.map((request) => request.url.path), [
      endsWith('/orders/301/confirm'),
      endsWith('/orders/302/preparing'),
      endsWith('/orders/303/dispatch'),
      endsWith('/orders/304/unavailable'),
      endsWith('/orders/305/cancel'),
    ]);
    expect(jsonDecode(requests[4].body), {
      'cancellation_reason': 'Patient requested cancellation',
    });
    expect(jsonDecode(requests[2].body), {
      'delivery_assignee_uid': '11111111-1111-4111-8111-111111111111',
    });
  });

  test('dispatch rejects legacy free-text courier identity locally', () async {
    await expectLater(
      PharmacyApiService.dispatchPharmacyOrder(303, const {
        'delivery_person': 'Courier One',
      }),
      throwsArgumentError,
    );
  });

  test('verification sends audited manual allergy review evidence', () async {
    late http.Request captured;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'id': 401, 'clinical_verification_status': 'override'},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await PharmacyApiService.verifyPharmacyOrder(
      401,
      decision: 'override',
      overrideReason: 'Prescriber confirmed the documented exception',
      manualAllergyReviewCompleted: true,
    );

    expect(captured.headers['Idempotency-Key'], isNotEmpty);
    expect(jsonDecode(captured.body), {
      'decision': 'override',
      'override_reason': 'Prescriber confirmed the documented exception',
      'manual_allergy_review_completed': true,
    });
  });

  test(
    'clinical closure reasons and break-glass evidence fail closed locally',
    () async {
      await expectLater(
        PharmacyApiService.verifyPharmacyOrder(
          401,
          decision: 'override',
          overrideReason: 'Documented clinical exception',
        ),
        throwsArgumentError,
      );
      await expectLater(
        PharmacyApiService.verifyPharmacyOrder(
          401,
          decision: 'rejected',
          notes: 'Unsafe',
        ),
        throwsArgumentError,
      );
      expect(
        () => PharmacyApiService.markPharmacyUnavailable(401, reason: ' '),
        throwsArgumentError,
      );
      await expectLater(
        PharmacyApiService.cancelPharmacyOrder(401, 'x'),
        throwsArgumentError,
      );
      await expectLater(
        PharmacyApiService.markPharmacyCounterDispensed(401, {
          'payment_mode': 'package',
          'amount_collected': 0,
        }),
        throwsArgumentError,
      );
      await expectLater(
        PharmacyApiService.markPharmacyCounterDispensed(401, {
          'payment_mode': 'insurance',
          'amount_collected': 0,
        }),
        throwsArgumentError,
      );
      await expectLater(
        PharmacyApiService.markPharmacyCounterDispensed(401, {
          'payment_mode': 'cash',
          'amount_collected': double.nan,
        }),
        throwsArgumentError,
      );
      await expectLater(
        PharmacyApiService.completePharmacyDelivery(
          401,
          handoffToken: 'short',
        ),
        throwsArgumentError,
      );
      expect(
        () => PharmacyApiService.reissuePharmacyDeliveryHandoff(
          401,
          reason: 'short',
        ),
        throwsArgumentError,
      );
      expect(
        () => PharmacyApiService.completePharmacyDeliveryReturn(
          401,
          disposition: 'restocked',
          reason: 'Documented pharmacy return disposition',
        ),
        throwsArgumentError,
      );
    },
  );

  test('delivery completion sends only handoff custody evidence', () async {
    late http.Request captured;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'id': 501, 'status': 'DELIVERED'},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await PharmacyApiService.completePharmacyDelivery(
      501,
      handoffToken: 'patient-handoff-token-501',
      breakGlassReason: 'Pharmacy in-charge verified patient handoff in person',
    );

    expect(captured.headers['Idempotency-Key'], isNotEmpty);
    expect(jsonDecode(captured.body), {
      'handoff_token': 'patient-handoff-token-501',
      'break_glass_reason':
          'Pharmacy in-charge verified patient handoff in person',
    });
  });
}
