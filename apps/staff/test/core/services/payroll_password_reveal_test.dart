import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/hr_api_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      'staff_jwt': 'staff-access-token',
      'jwt': 'staff-access-token',
    });
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  test(
    'posts an empty body to the self-service reveal path and unwraps it',
    () async {
      var calls = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          calls += 1;
          expect(request.method, 'POST');
          expect(
            request.url.path,
            endsWith('/staff/hr/payroll/my-payslips/7/password'),
          );
          expect(jsonDecode(request.body), isEmpty);
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'password': 'PDF-only-secret'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      expect(await HrApiService.revealPayslipPassword('7'), 'PDF-only-secret');
      expect(calls, 1);
    },
  );

  for (final status in [400, 401, 403, 404, 500]) {
    test('handles $status without echoing the backend response', () async {
      var calls = 0;
      VHHttpClient.setClientForTesting(
        MockClient((_) async {
          calls += 1;
          return http.Response(
            jsonEncode({
              'success': false,
              'message': 'backend credential PDF-only-secret',
            }),
            status,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      await expectLater(
        HrApiService.revealPayslipPassword('7'),
        throwsA(
          isA<PayslipPasswordRevealException>()
              .having((error) => error.statusCode, 'statusCode', status)
              .having(
                (error) => error.toString(),
                'safe message',
                isNot(contains('PDF-only-secret')),
              ),
        ),
      );
      expect(calls, 1);
    });
  }
}
