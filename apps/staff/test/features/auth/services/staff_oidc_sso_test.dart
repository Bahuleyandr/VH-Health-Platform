import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/config/api_config.dart' as core_config;
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/auth_service.dart';

http.Response _ok(Object data) => http.Response(
  jsonEncode({'success': true, 'data': data}),
  200,
  headers: {'content-type': 'application/json'},
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = () => 'tablet';
    AuthService.debugStaffSsoBrowser = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.deviceTypeProvider = null;
    AuthService.debugStaffSsoBrowser = null;
  });

  test('discovers enabled staff OIDC providers', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(
          request.url.toString(),
          '${core_config.ApiConfig.baseUrl}/auth/staff/sso/oidc/providers',
        );
        return _ok({
          'providers': [
            {
              'provider_key': 'keycloak-staff',
              'display_name': 'Keycloak Staff',
              'start_url': '/api/v1/auth/staff/sso/oidc/keycloak-staff/start',
              'redirect_uris': ['vhhealthstaff://sso/oidc/callback'],
            },
          ],
        });
      }),
    );

    final providers = await AuthService.discoverStaffSsoProviders();

    expect(providers, hasLength(1));
    expect(providers.first.providerKey, 'keycloak-staff');
    expect(providers.first.redirectUris, ['vhhealthstaff://sso/oidc/callback']);
  });

  test('opens system-browser SSO and stores returned staff token', () async {
    final observedPaths = <String>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        observedPaths.add(request.url.path);
        if (request.method == 'GET' &&
            request.url.path.endsWith(
              '/auth/staff/sso/oidc/keycloak-staff/start',
            )) {
          expect(request.url.queryParameters['response_mode'], 'json');
          expect(
            request.url.queryParameters['redirect_uri'],
            'vhhealthstaff://sso/oidc/callback',
          );
          expect(
            request.url.queryParameters['deviceType'],
            isIn(['desktop', 'mobile', 'tablet', 'web']),
          );
          return _ok({
            'redirectUrl':
                'https://idp.example.test/auth?client_id=vh-staff&state=opaque-state',
          });
        }
        if (request.method == 'POST' &&
            request.url.path.endsWith(
              '/auth/staff/sso/oidc/keycloak-staff/callback',
            )) {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          expect(body['code'], 'auth-code');
          expect(body['state'], 'opaque-state');
          expect(body['redirect_uri'], 'vhhealthstaff://sso/oidc/callback');
          expect(
            body['deviceType'],
            isIn(['desktop', 'mobile', 'tablet', 'web']),
          );
          return _ok({
            'accessToken': 'header.payload.signature',
            'refreshToken': 'refresh-token',
            'staff': {
              'id': 'staff-42',
              'uid': 'staff-uid-42',
              'employeeId': 'EMP-42',
              'role': 'NURSING_STAFF',
            },
          });
        }
        return http.Response('not found', 404);
      }),
    );
    AuthService.debugStaffSsoBrowser =
        ({required String url, required String callbackUrlScheme}) async {
          expect(url, contains('https://idp.example.test/auth'));
          expect(callbackUrlScheme, 'vhhealthstaff');
          return 'vhhealthstaff://sso/oidc/callback?code=auth-code&state=opaque-state';
        };

    final data = await AuthService.loginWithStaffSso(
      const StaffSsoProvider(
        providerKey: 'keycloak-staff',
        displayName: 'Keycloak Staff',
        startUrl: '/api/v1/auth/staff/sso/oidc/keycloak-staff/start',
        redirectUris: ['vhhealthstaff://sso/oidc/callback'],
      ),
    );

    const storage = FlutterSecureStorage();
    expect(data['accessToken'], 'header.payload.signature');
    expect(await storage.read(key: 'staff_jwt'), 'header.payload.signature');
    expect(await storage.read(key: 'jwt'), 'header.payload.signature');
    expect(await storage.read(key: 'refreshToken'), 'refresh-token');
    expect(await storage.read(key: 'employee_id'), 'EMP-42');
    expect(
      observedPaths,
      contains(endsWith('/auth/staff/sso/oidc/keycloak-staff/start')),
    );
    expect(
      observedPaths,
      contains(endsWith('/auth/staff/sso/oidc/keycloak-staff/callback')),
    );
  });
}
