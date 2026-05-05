import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:integration_test/integration_test.dart';
import 'package:vhhealth_staff/core/config/api_config.dart';
import 'package:vhhealth_staff/core/services/websocket_service.dart';
import 'package:vhhealth_staff/main.dart' as app;

class _StaffLoginCase {
  const _StaffLoginCase(this.employeeDigits, this.expectedRole);

  final String employeeDigits;
  final String expectedRole;

  String get employeeId => 'EMP-$employeeDigits';
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  const password = String.fromEnvironment('VH_STAFF_TEST_PASSWORD');
  const accounts = [
    _StaffLoginCase('1001', 'NURSING_STAFF'),
    _StaffLoginCase('1002', 'PHARMACY_STAFF'),
    _StaffLoginCase('1003', 'LAB_STAFF'),
    _StaffLoginCase('1004', 'DOCTOR'),
    _StaffLoginCase('1005', 'HR_STAFF'),
    _StaffLoginCase('1006', 'ADMIN'),
    _StaffLoginCase('1007', 'SUPER_ADMIN'),
    _StaffLoginCase('1008', 'GENERAL_STAFF'),
  ];

  Future<void> pumpFor(WidgetTester tester, Duration duration) async {
    const tick = Duration(milliseconds: 250);
    var elapsed = Duration.zero;
    while (elapsed < duration) {
      await tester.pump(tick);
      elapsed += tick;
    }
  }

  Future<void> waitFor(
    WidgetTester tester,
    Finder finder, {
    Duration timeout = const Duration(seconds: 30),
    String? reason,
  }) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      await tester.pump(const Duration(milliseconds: 250));
      if (finder.evaluate().isNotEmpty) return;
    }
    fail(reason ?? 'Timed out waiting for $finder');
  }

  void expectCleanLoginResult(WidgetTester tester, String context) {
    final error = tester.takeException();
    if (error != null) {
      fail('$context threw a Flutter exception: $error');
    }

    expect(find.textContaining('Login failed'), findsNothing, reason: context);
    expect(find.textContaining('Invalid'), findsNothing, reason: context);
    expect(
      find.textContaining('SocketException'),
      findsNothing,
      reason: context,
    );
    expect(
      find.textContaining('ClientException'),
      findsNothing,
      reason: context,
    );
    expect(
      find.textContaining('Request failed'),
      findsNothing,
      reason: context,
    );
    expect(find.textContaining('HTTP 401'), findsNothing, reason: context);
    expect(find.textContaining('HTTP 500'), findsNothing, reason: context);
  }

  testWidgets(
    'staff Windows app logs in every seeded role account',
    (tester) async {
      if (password.isEmpty) {
        markTestSkipped(
          'Set --dart-define=VH_STAFF_TEST_PASSWORD for seeded staff login smoke tests.',
        );
        return;
      }

      await const FlutterSecureStorage().deleteAll();
      WebSocketService.instance.disconnect();
      final previousErrorWidgetBuilder = ErrorWidget.builder;
      addTearDown(() async {
        ErrorWidget.builder = previousErrorWidgetBuilder;
        WebSocketService.instance.disconnect();
        await const FlutterSecureStorage().deleteAll();
      });

      app.main();

      await waitFor(
        tester,
        find.byType(TextFormField),
        reason: 'Login form did not render',
      );
      ErrorWidget.builder = previousErrorWidgetBuilder;

      for (final account in accounts) {
        debugPrint('Staff all-logins smoke: ${account.employeeId}');
        await tester.enterText(
          find.byType(TextFormField).at(0),
          account.employeeDigits,
        );
        await tester.enterText(find.byType(TextFormField).at(1), password);
        await tester.tap(find.byType(ElevatedButton).last);

        await waitFor(
          tester,
          find.text('Daily Work'),
          timeout: const Duration(seconds: 35),
          reason: 'Dashboard did not render for ${account.employeeId}',
        );
        await pumpFor(tester, const Duration(seconds: 1));

        expectCleanLoginResult(tester, account.employeeId);
        expect(await ApiConfig.getEmployeeId(), account.employeeId);
        expect(await ApiConfig.getRole(), account.expectedRole);

        await ApiConfig.clearAll();
        WebSocketService.instance.disconnect();
        GoRouter.of(tester.element(find.byType(Scaffold).first)).go('/login');
        await pumpFor(tester, const Duration(seconds: 2));
        await waitFor(
          tester,
          find.byType(TextFormField),
          reason: 'Login form did not render after ${account.employeeId}',
        );
      }
    },
    timeout: const Timeout(Duration(minutes: 10)),
  );
}
