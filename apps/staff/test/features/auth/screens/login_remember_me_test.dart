// "Remember my Employee ID" wiring (P3 hygiene 2026-08).
//
// The checkbox was previously inert: AuthService persisted the employee ID
// unconditionally, so a shared ward device always pre-filled the last user's
// ID on the next launch. These tests pin both states end-to-end through the
// real login screen + AuthService persistence path:
//   * checked (default)  → employee ID stored, pre-filled next launch;
//   * unchecked          → employee ID never persisted, and any previously
//                          remembered ID is cleared by the opt-out login.
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
import 'package:vhhealth_staff/core/config/api_config.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';
import 'package:vhhealth_staff/core/services/auth_service.dart';
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

Future<void> _pumpLogin(WidgetTester tester) async {
  VHHttpClient.setClientForTesting(
    MockClient((request) async {
      if (request.method == 'GET' &&
          request.url.path.endsWith('/auth/staff/sso/oidc/providers')) {
        return _ok({'providers': const []});
      }
      if (request.method == 'POST' &&
          request.url.path.endsWith('/auth/staff/register-device')) {
        return _ok({
          'accessToken': 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzdGFmZi11aWQiLCJyb2xlIjoiTlVSU0lOR19TVEFGRiJ9.sig',
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

Future<void> _signInWithPassword(WidgetTester tester) async {
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
    await ApiConfig.clearSessionIdentity();
  });

  testWidgets('checked by default: login persists the employee ID', (
    tester,
  ) async {
    await _pumpLogin(tester);

    final checkbox = tester.widget<Checkbox>(find.byType(Checkbox));
    expect(checkbox.value, isTrue, reason: 'default must stay opt-in');

    await _signInWithPassword(tester);

    expect(await ApiConfig.getEmployeeId(), 'EMP-1001');
    expect(
      (await AuthService.getSavedCredentials())?['employeeId'],
      'EMP-1001',
    );
  });

  testWidgets('unchecked: login never persists the employee ID', (
    tester,
  ) async {
    await _pumpLogin(tester);

    await tester.ensureVisible(find.byType(Checkbox));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    expect(tester.widget<Checkbox>(find.byType(Checkbox)).value, isFalse);

    await _signInWithPassword(tester);

    expect(await ApiConfig.getEmployeeId(), isNull);
    expect(await AuthService.getSavedCredentials(), isNull);
  });

  testWidgets('unchecked: an opt-out login clears a previously remembered ID', (
    tester,
  ) async {
    // A prior user remembered their ID on this shared device.
    FlutterSecureStorage.setMockInitialValues({'employee_id': 'EMP-9999'});
    await _pumpLogin(tester);

    // Pre-fill proves the stale ID was live before the opt-out login.
    expect(
      tester
          .widget<TextFormField>(_fieldWithLabel('Employee ID'))
          .controller
          ?.text,
      '9999',
    );

    await tester.ensureVisible(find.byType(Checkbox));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Checkbox));
    await tester.pump();

    await _signInWithPassword(tester);

    expect(await ApiConfig.getEmployeeId(), isNull);
    expect(await AuthService.getSavedCredentials(), isNull);
  });
}
