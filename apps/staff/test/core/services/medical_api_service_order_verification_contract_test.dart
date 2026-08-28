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
    'clinical-order verification sends the caller-owned command key',
    () async {
      late http.Request captured;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 42, 'status': 'verified'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final result = await MedicalApiService.verifyOrder(
        42,
        idempotencyKey: 'clinical-order-verify:test-42',
      );

      expect(result['status'], 'verified');
      expect(captured.method, 'PUT');
      expect(captured.url.path, endsWith('/emr/orders/42/verify'));
      expect(
        captured.headers['idempotency-key'],
        'clinical-order-verify:test-42',
      );
      expect(jsonDecode(captured.body), <String, dynamic>{});
    },
  );
}
