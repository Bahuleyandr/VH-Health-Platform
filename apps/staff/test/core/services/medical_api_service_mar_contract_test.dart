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
      );

      expect(result['status'], 'administered');
      expect(captured.method, 'POST');
      expect(
        captured.url.path,
        endsWith('/clinical/mar/42/administer-with-scan'),
      );
      expect(captured.headers['idempotency-key'], isNotEmpty);
      expect(jsonDecode(captured.body), {
        'scanned_patient_uid': '11111111-1111-4111-8111-111111111111',
        'scanned_barcode': 'BATCH-42',
        'supply_override_reason':
            'Ward emergency stock used with charge nurse approval',
        'supply_quantity': 1.5,
      });
    },
  );

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
