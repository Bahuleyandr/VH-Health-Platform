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
    'recordVitals mints one key and reuses it across a transport retry',
    () async {
      final keys = <String?>[];
      var attempts = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          attempts++;
          keys.add(request.headers['idempotency-key']);
          expect(request.method, 'POST');
          expect(request.url.path, endsWith('/health/records'));
          expect(jsonDecode(request.body), {
            'patient_id': 77,
            'record_type': 'VITALS',
            'vital_signs': {'pulse': 72},
          });
          if (attempts == 1) {
            return http.Response(
              jsonEncode({'success': false, 'message': 'transient'}),
              500,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 901},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final result = await MedicalApiService.recordVitals(
        patientId: 77,
        vitalSigns: {'pulse': 72},
      );

      expect(result['id'], 901);
      expect(attempts, 2);
      expect(keys[0], isNotNull);
      expect(keys[0], isNotEmpty);
      expect(keys[1], keys[0]);
    },
  );

  test(
    'recordVitals reuses a caller-persisted key across logical replay',
    () async {
      final keys = <String?>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          keys.add(request.headers['idempotency-key']);
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 902},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      const persistedKey = 'staff-vitals-offline-47';
      await MedicalApiService.recordVitals(
        patientId: 77,
        vitalSigns: {'pulse': 72},
        idempotencyKey: persistedKey,
      );
      await MedicalApiService.recordVitals(
        patientId: 77,
        vitalSigns: {'pulse': 72},
        idempotencyKey: persistedKey,
      );

      expect(keys, [persistedKey, persistedKey]);
    },
  );
}
