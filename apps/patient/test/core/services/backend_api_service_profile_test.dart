import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/core/services/backend_api_service.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late PatientOutageController outageController;

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({'jwt': 'patient-access-token'});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.appCheckTokenProvider = null;

    outageController = PatientOutageController.forTesting(
      request: () => throw StateError('readiness must not be called'),
      authentication: () async => 'patient-access-token',
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
    )..markAvailableForTesting();
    PatientOutageController.setForTesting(outageController);
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.appCheckTokenProvider = null;
    PatientOutageController.resetAfterTesting();
    outageController.dispose();
  });

  test('profile completion uses the authenticated patient API client', () {
    final source = File(
      'lib/core/services/backend_api_service.dart',
    ).readAsStringSync();

    expect(source, contains("import 'api_client.dart';"));
    expect(
      source,
      matches(
        RegExp(
          r'saveUserProfile[\s\S]*?ApiClient\.post\('
          r"\s*'/auth/firebase/complete-profile'",
        ),
      ),
    );
    expect(
      source,
      isNot(
        contains(
          "Uri.parse('\${ApiConfig.baseUrl}/auth/firebase/complete-profile')",
        ),
      ),
    );
  });

  test('profile completion sends the local JWT and profile contract', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, endsWith('/auth/firebase/complete-profile'));
        expect(request.headers['authorization'], 'Bearer patient-access-token');
        expect(jsonDecode(request.body), {
          'phone': '+919876543210',
          'name': 'Patient One',
          'gender': 'OTHER',
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'profileCompleted': true},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final saved = await BackendApiService.saveUserProfile({
      'phone': '+919876543210',
      'name': 'Patient One',
      'gender': 'OTHER',
    });

    expect(saved, isTrue);
  });

  test('profile completion reports backend rejection to the screen', () async {
    VHHttpClient.setClientForTesting(
      MockClient(
        (_) async => http.Response(
          jsonEncode({
            'success': false,
            'message': 'Authenticated user does not match requested phone',
          }),
          403,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );

    final saved = await BackendApiService.saveUserProfile({
      'phone': '+919876543211',
      'name': 'Patient Two',
      'gender': 'OTHER',
    });

    expect(saved, isFalse);
  });

  test(
    'Firebase login uses shared unauthenticated transport with App Check',
    () async {
      VHHttpClient.appCheckTokenProvider = () async => 'app-check-token';
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, endsWith('/auth/firebase/firebase-login'));
          expect(request.headers['authorization'], isNull);
          expect(request.headers['x-firebase-appcheck'], 'app-check-token');
          expect(jsonDecode(request.body), {
            'idToken': 'firebase-id-token',
            'deviceType': 'mobile',
          });
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'accessToken': 'header.payload.signature',
                'user': {'phone': '+919876543210'},
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final response = await BackendApiService.firebaseLogin(
        'firebase-id-token',
      );

      expect(response.isSuccess, isTrue);
      expect(response.dataAsMap()['accessToken'], 'header.payload.signature');
    },
  );
}
