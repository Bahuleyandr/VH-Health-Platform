import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/auth_service.dart' as core_auth;
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';
import 'package:vhhealth_staff/features/auth/screens/login_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

http.Response _ok(Object data) => http.Response(
  jsonEncode({'success': true, 'data': data}),
  200,
  headers: {'content-type': 'application/json'},
);

Widget _host(GoRouter router) {
  return ChangeNotifierProvider(
    create: (_) =>
        SessionTimeoutProvider(timeoutDuration: const Duration(hours: 1)),
    child: MaterialApp.router(
      debugShowCheckedModeBanner: false,
      supportedLocales: AppStrings.supportedLocales,
      routerConfig: router,
    ),
  );
}

GoRouter _router() {
  return GoRouter(
    initialLocation: '/login',
    routes: [
      GoRoute(
        path: '/login',
        pageBuilder: (context, state) =>
            const NoTransitionPage(child: LoginScreen()),
      ),
      GoRoute(
        path: '/dashboard',
        pageBuilder: (context, state) => const NoTransitionPage(
          child: Scaffold(body: Center(child: Text('Dashboard Ready'))),
        ),
      ),
    ],
  );
}

Finder _fieldWithLabel(String label) =>
    find.widgetWithText(TextFormField, label);

Future<void> _pumpLogin(
  WidgetTester tester, {
  required List<Object> providers,
}) async {
  VHHttpClient.setClientForTesting(
    MockClient((request) async {
      if (request.method == 'GET' &&
          request.url.path.endsWith('/auth/staff/sso/oidc/providers')) {
        return _ok({'providers': providers});
      }
      if (request.method == 'POST' &&
          request.url.path.endsWith('/auth/staff/register-device')) {
        return _ok({
          'accessToken':
              'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzdGFmZi11aWQiLCJyb2xlIjoiTlVSU0lOR19TVEFGRiJ9.sig',
          'refreshToken': 'refresh-token',
          'deviceToken': 'trusted-device-token',
          'staff': {
            'id': 'staff-1',
            'uid': 'staff-uid-1',
            'employeeId': 'EMP-1001',
            'role': 'NURSING_STAFF',
          },
        });
      }
      return _ok({});
    }),
  );

  await tester.pumpWidget(_host(_router()));
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = () => 'tablet';
  });

  tearDown(() async {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
    await core_auth.AuthService.clearSessionIdentity();
  });

  testWidgets('hides SSO button when staff discovery has no active provider', (
    tester,
  ) async {
    await _pumpLogin(tester, providers: const []);

    expect(find.text('Sign in with SSO'), findsNothing);
    expect(find.text('Sign In with Password'), findsOneWidget);
    expect(find.text('PIN'), findsOneWidget);

    await tester.tap(find.text('PIN'));
    await tester.pumpAndSettle();

    expect(_fieldWithLabel('PIN'), findsOneWidget);
    expect(find.text('Sign In with PIN'), findsOneWidget);
  });

  testWidgets('shows SSO button only after provider discovery succeeds', (
    tester,
  ) async {
    await _pumpLogin(
      tester,
      providers: const [
        {
          'provider_key': 'keycloak-staff',
          'display_name': 'Keycloak Staff',
          'start_url': '/api/v1/auth/staff/sso/oidc/keycloak-staff/start',
          'redirect_uris': ['vhhealthstaff://sso/oidc/callback'],
        },
      ],
    );

    expect(find.text('Sign in with SSO'), findsOneWidget);
    expect(find.text('Sign In with Password'), findsOneWidget);
  });

  testWidgets('password login continues through the normal post-login route', (
    tester,
  ) async {
    await _pumpLogin(tester, providers: const []);

    await tester.enterText(_fieldWithLabel('Employee ID'), '1001');
    await tester.enterText(_fieldWithLabel('Password'), 'Password1!');
    final passwordButton = find.widgetWithText(
      ElevatedButton,
      'Sign In with Password',
    );
    await tester.ensureVisible(passwordButton);
    await tester.pumpAndSettle();
    await tester.tap(passwordButton);
    await tester.pumpAndSettle();

    expect(find.text('Dashboard Ready'), findsOneWidget);
  });
}
