import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/medical_api_service.dart';

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
    'online scanned administration omits retrospective administered_at',
    () async {
      late http.Request captured;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 42, 'status': 'administered'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final result = await MedicalApiService.administerWithScan(
        maId: 42,
        scannedPatientUid: '11111111-1111-4111-8111-111111111111',
        scannedBarcode: 'BATCH-42',
        supplyOverrideReason:
            'Ward emergency stock used with charge nurse approval',
        supplyQuantity: 1.5,
        idempotencyKey: 'mar-administer-scan:42:test',
      );

      expect(result['status'], 'administered');
      expect(captured.method, 'POST');
      expect(
        captured.url.path,
        endsWith('/clinical/mar/42/administer-with-scan'),
      );
      expect(
        captured.headers['idempotency-key'],
        'mar-administer-scan:42:test',
      );
      expect(jsonDecode(captured.body), {
        'scanned_patient_uid': '11111111-1111-4111-8111-111111111111',
        'scanned_barcode': 'BATCH-42',
        'supply_override_reason':
            'Ward emergency stock used with charge nurse approval',
        'supply_quantity': 1.5,
      });
    },
  );

  test('authoritative MAR refresh selects the exact administration', () async {
    late http.Request captured;
    const patientUid = '11111111-1111-4111-8111-111111111111';
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': [
              {'id': 41, 'status': 'scheduled'},
              {'id': 42, 'status': 'administered'},
            ],
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final result = await MedicalApiService.getMedicationAdministration(
      maId: 42,
      patientUid: patientUid,
      scheduledDate: '2026-08-28',
    );

    expect(result, {'id': 42, 'status': 'administered'});
    expect(captured.method, 'GET');
    expect(captured.url.path, endsWith('/clinical/mar/patient/$patientUid'));
    expect(captured.url.queryParameters, {'date': '2026-08-28'});
  });

  test('supply state uses the MAR custody evidence endpoint', () async {
    late http.Request captured;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'status': 'available', 'available_quantity': 2},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final result = await MedicalApiService.getMarSupplyState(maId: 42);

    expect(result['status'], 'available');
    expect(captured.method, 'GET');
    expect(captured.url.path, endsWith('/clinical/mar/42/supply'));
  });

  test('supply reconciliation sends exact allocation quantities', () async {
    late http.Request captured;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'status': 'matched', 'task_completed': true},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final result = await MedicalApiService.reconcileMarSupplyOverride(
      maId: 42,
      consumptionId: '9007199254740993',
      allocations: const [
        {'inventory_allocation_id': '9007199254740994', 'quantity': 1.25},
        {'inventory_allocation_id': '9223372036854775807', 'quantity': 0.75},
      ],
      idempotencyKey: 'mar-supply-reconcile:test',
    );

    expect(result['task_completed'], isTrue);
    expect(captured.method, 'POST');
    expect(
      captured.url.path,
      endsWith('/clinical/mar/42/supply-overrides/9007199254740993/reconcile'),
    );
    expect(captured.headers['idempotency-key'], 'mar-supply-reconcile:test');
    expect(jsonDecode(captured.body), {
      'allocations': [
        {'inventory_allocation_id': '9007199254740994', 'quantity': 1.25},
        {'inventory_allocation_id': '9223372036854775807', 'quantity': 0.75},
      ],
    });
  });

  test(
    'supply reconciliation rejects IDs outside database wire ranges',
    () async {
      await expectLater(
        MedicalApiService.getMarSupplyState(maId: 2147483648),
        throwsArgumentError,
      );
      for (final invoke in <void Function()>[
        () => MedicalApiService.reconcileMarSupplyOverride(
          maId: 42,
          consumptionId: '9223372036854775808',
          allocations: const [
            {'inventory_allocation_id': '7', 'quantity': 1},
          ],
        ),
        () => MedicalApiService.reconcileMarSupplyOverride(
          maId: 42,
          consumptionId: '7',
          allocations: const [
            {'inventory_allocation_id': 7, 'quantity': 1},
          ],
        ),
        () => MedicalApiService.reconcileMarSupplyOverride(
          maId: 42,
          consumptionId: '7',
          allocations: const [
            {'inventory_allocation_id': '9223372036854775808', 'quantity': 1},
          ],
        ),
      ]) {
        expect(invoke, throwsArgumentError);
      }
    },
  );

  test(
    'clinical-order MAR recovery uses the governed replay-safe endpoint',
    () async {
      late http.Request captured;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'order_id': 42,
                'status': 'scheduled',
                'scheduled_dose_count': 2,
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final result = await MedicalApiService.retryMedicationOrderMarScheduling(
        orderId: 42,
      );

      expect(result['scheduled_dose_count'], 2);
      expect(captured.method, 'POST');
      expect(
        captured.url.path,
        endsWith('/emr/orders/42/retry-mar-scheduling'),
      );
      expect(captured.headers['idempotency-key'], isNotEmpty);
      expect(jsonDecode(captured.body), <String, dynamic>{});
    },
  );

  test('prescriber hold release sends reason and caller-owned key', () async {
    late http.Request captured;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'id': 42, 'status': 'scheduled'},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final result = await MedicalApiService.releaseHeldMedication(
      maId: 42,
      reason: '  Prescriber reviewed observations and approved release  ',
      idempotencyKey: 'mar-release-hold:test',
    );

    expect(result['status'], 'scheduled');
    expect(captured.method, 'POST');
    expect(captured.url.path, endsWith('/clinical/mar/42/release-hold'));
    expect(captured.headers['idempotency-key'], 'mar-release-hold:test');
    expect(jsonDecode(captured.body), {
      'reason': 'Prescriber reviewed observations and approved release',
    });
  });

  test(
    'prescriber exception queue and disposition use the governed endpoints',
    () async {
      final captured = <http.Request>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured.add(request);
          if (request.method == 'GET') {
            return http.Response(
              jsonEncode({
                'success': true,
                'data': [
                  {'id': 42, 'exception_case_id': 73, 'status': 'missed'},
                ],
              }),
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'exception_case_id': 73,
                'status': 'resolved',
                'disposition': 'replacement_ordered',
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final queue = await MedicalApiService.getMedicationExceptions();
      final disposition =
          await MedicalApiService.recordMedicationExceptionDisposition(
            caseId: '73',
            disposition: 'replacement_ordered',
            reason: '  Replacement prescribed through CPOE  ',
            replacementClinicalOrderId: 91,
            idempotencyKey: 'mar-exception:73:test',
          );

      expect(queue.single['exception_case_id'], 73);
      expect(disposition['status'], 'resolved');
      expect(captured[0].method, 'GET');
      expect(captured[0].url.path, endsWith('/clinical/mar/exceptions'));
      expect(captured[1].method, 'POST');
      expect(
        captured[1].url.path,
        endsWith('/clinical/mar/exceptions/73/disposition'),
      );
      expect(captured[1].headers['idempotency-key'], 'mar-exception:73:test');
      expect(jsonDecode(captured[1].body), {
        'disposition': 'replacement_ordered',
        'reason': 'Replacement prescribed through CPOE',
        'replacement_clinical_order_id': 91,
      });
    },
  );

  test(
    'replacement selection refreshes the authoritative patient medication page',
    () async {
      late http.Request captured;
      const patientUid = '11111111-1111-4111-8111-111111111111';
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': [
                {
                  'id': 91,
                  'patient_uid': patientUid,
                  'order_type': 'medication',
                  'status': 'ordered',
                },
              ],
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final orders = await MedicalApiService.getPatientMedicationOrders(
        patientUid,
      );

      expect(orders.single['id'], 91);
      expect(captured.method, 'GET');
      expect(captured.url.path, endsWith('/emr/orders/patient/$patientUid'));
      expect(captured.url.queryParameters, {
        'order_type': 'medication',
        'limit': '100',
      });
    },
  );

  for (final transition
      in <
        ({
          String name,
          String path,
          String status,
          Future<Map<String, dynamic>> Function() invoke,
        })
      >[
        (
          name: 'missed dose',
          path: '/clinical/mar/42/miss',
          status: 'missed',
          invoke: () => MedicalApiService.markMedicationMissed(
            maId: 42,
            reason: '  Patient declined after counselling  ',
          ),
        ),
        (
          name: 'held dose',
          path: '/clinical/mar/42/hold',
          status: 'held',
          invoke: () => MedicalApiService.holdMedication(
            maId: 42,
            reason: '  Awaiting prescriber review  ',
          ),
        ),
      ]) {
    test('${transition.name} sends a reason and idempotency key', () async {
      late http.Request captured;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 42, 'status': transition.status},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final result = await transition.invoke();

      expect(result['status'], transition.status);
      expect(captured.method, 'POST');
      expect(captured.url.path, endsWith(transition.path));
      expect(captured.headers['idempotency-key'], isNotEmpty);
      expect(jsonDecode(captured.body), {
        'reason': transition.status == 'missed'
            ? 'Patient declined after counselling'
            : 'Awaiting prescriber review',
      });
    });
  }
}
