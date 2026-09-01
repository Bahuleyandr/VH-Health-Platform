import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/medical_api_service.dart';
import 'package:vhhealth_staff/core/services/order_payloads.dart';

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
    'inpatient CPOE sends explicit ward-supply evidence in details',
    () async {
      final captured = <http.Request>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured.add(request);
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 42, 'status': 'ordered'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final body = buildInpatientMedicationOrderBody(
        patientUid: '11111111-1111-4111-8111-111111111111',
        encounterId: '22222222-2222-4222-8222-222222222222',
        medicationName: 'Ceftriaxone',
        dose: '1 g',
        route: 'iv',
        frequency: 'BD',
        quantityRequested: 6,
        unit: 'vial',
        catalogId: 73,
        startDate: DateTime.utc(2026, 8, 28, 9),
      );
      await MedicalApiService.createEmrOrder(
        body,
        idempotencyKey: 'staff-inpatient-order-attempt-1',
      );
      await MedicalApiService.createEmrOrder(
        body,
        idempotencyKey: 'staff-inpatient-order-attempt-1',
      );
      await MedicalApiService.createEmrOrder({
        ...body,
        'notes': 'new logical attempt',
      }, idempotencyKey: 'staff-inpatient-order-attempt-2');

      expect(captured, hasLength(3));
      expect(captured[0].method, 'POST');
      expect(captured[0].url.path, endsWith('/emr/orders'));
      expect(
        captured[0].headers['idempotency-key'],
        'staff-inpatient-order-attempt-1',
      );
      expect(
        captured[1].headers['idempotency-key'],
        captured[0].headers['idempotency-key'],
      );
      expect(captured[1].body, captured[0].body);
      expect(
        captured[2].headers['idempotency-key'],
        'staff-inpatient-order-attempt-2',
      );
      expect(captured[2].body, isNot(captured[1].body));
      final submitted = jsonDecode(captured[0].body) as Map<String, dynamic>;
      final details = submitted['details'] as Map<String, dynamic>;
      expect(details['catalog_id'], 73);
      expect(details['quantity_requested'], 6);
      expect(details['unit'], 'vial');
    },
  );

  test('bulk CPOE requires and sends the caller attempt identity', () async {
    final captured = <http.Request>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        captured.add(request);
        return http.Response(
          jsonEncode({'success': true, 'data': <dynamic>[]}),
          201,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final orders = <Map<String, dynamic>>[
      {
        'patient_uid': '11111111-1111-4111-8111-111111111111',
        'order_type': 'investigation',
        'details': {'test_name': 'CBC'},
      },
    ];
    await MedicalApiService.createEmrOrdersBulkRaw(
      orders,
      idempotencyKey: 'staff-bulk-order-attempt-1',
    );
    await MedicalApiService.createEmrOrdersBulkRaw(
      orders,
      idempotencyKey: 'staff-bulk-order-attempt-1',
    );
    await MedicalApiService.createEmrOrdersBulkRaw([
      ...orders,
      {
        'patient_uid': orders.first['patient_uid'],
        'order_type': 'nursing',
        'details': {'description': 'new attempt'},
      },
    ], idempotencyKey: 'staff-bulk-order-attempt-2');

    expect(captured, hasLength(3));
    expect(captured[0].url.path, endsWith('/emr/orders/bulk'));
    expect(
      captured[0].headers['idempotency-key'],
      'staff-bulk-order-attempt-1',
    );
    expect(
      captured[1].headers['idempotency-key'],
      captured[0].headers['idempotency-key'],
    );
    expect(captured[1].body, captured[0].body);
    expect(
      captured[2].headers['idempotency-key'],
      'staff-bulk-order-attempt-2',
    );
    expect(captured[2].body, isNot(captured[1].body));
  });
}
