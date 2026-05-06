import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:vhhealth_staff/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

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
    Duration timeout = const Duration(seconds: 20),
    String? reason,
  }) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      await tester.pump(const Duration(milliseconds: 250));
      if (finder.evaluate().isNotEmpty) return;
    }
    fail(reason ?? 'Timed out waiting for $finder');
  }

  void expectCleanScreen(WidgetTester tester, String context) {
    final error = tester.takeException();
    if (error != null) {
      fail('$context threw a Flutter exception: $error');
    }

    expect(
      find.textContaining('Page not found'),
      findsNothing,
      reason: context,
    );
    expect(find.textContaining('Cannot GET'), findsNothing, reason: context);
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
    expect(
      find.textContaining('Failed to load'),
      findsNothing,
      reason: context,
    );
    expect(
      find.textContaining('Something went wrong'),
      findsNothing,
      reason: context,
    );
    expect(find.textContaining('Exception'), findsNothing, reason: context);
    expect(find.textContaining('HTTP 404'), findsNothing, reason: context);
    expect(find.textContaining('HTTP 500'), findsNothing, reason: context);
    expect(
      find.textContaining('Request failed (404)'),
      findsNothing,
      reason: context,
    );
    expect(
      find.textContaining('Request failed (500)'),
      findsNothing,
      reason: context,
    );
  }

  Future<void> scrollToText(WidgetTester tester, String label) async {
    final finder = find.text(label);
    if (finder.evaluate().isNotEmpty) {
      await tester.ensureVisible(finder.first);
      await tester.pump(const Duration(milliseconds: 150));
      return;
    }

    await tester.scrollUntilVisible(
      finder,
      520,
      maxScrolls: 24,
      scrollable: find.byType(Scrollable).evaluate().isNotEmpty
          ? find.byType(Scrollable).first
          : throw StateError(
              'Expected "$label" but no scrollable surface was available',
            ),
    );
    await tester.pump(const Duration(milliseconds: 150));
  }

  Future<void> tapVisibleText(
    WidgetTester tester,
    String label, {
    bool last = true,
  }) async {
    debugPrint('Staff desktop smoke: opening "$label"');
    final finder = find.text(label);
    await scrollToText(tester, label);
    await waitFor(
      tester,
      finder,
      timeout: const Duration(seconds: 8),
      reason: 'Expected "$label" to be present',
    );
    await tester.ensureVisible(last ? finder.last : finder.first);
    await tester.pump(const Duration(milliseconds: 150));
    await tester.tap(last ? finder.last : finder.first);
    await pumpFor(tester, const Duration(seconds: 2));
  }

  Future<void> expandMoreTools(WidgetTester tester) async {
    final moreTools = find.text('More tools');
    await scrollToText(tester, 'More tools');
    await waitFor(
      tester,
      moreTools,
      timeout: const Duration(seconds: 8),
      reason: 'Expected More tools section to be present',
    );
    await tester.ensureVisible(moreTools.last);
    await tester.pump(const Duration(milliseconds: 150));
    await tester.tap(moreTools.last);
    await pumpFor(tester, const Duration(milliseconds: 600));
  }

  Future<void> tapDashboardItem(WidgetTester tester, String label) async {
    final finder = find.text(label);
    if (finder.evaluate().isEmpty) {
      await expandMoreTools(tester);
    }
    await tapVisibleText(tester, label);
  }

  Future<void> goHome(WidgetTester tester) async {
    final home = find.text('Home');
    if (home.evaluate().isNotEmpty) {
      await tester.tap(home.last);
      await pumpFor(tester, const Duration(seconds: 2));
    }
    await waitFor(tester, find.text('Daily Work'));
    await waitFor(tester, find.text('More tools'));
  }

  testWidgets(
    'staff Windows app logs in and opens primary dashboard routes',
    (tester) async {
      await const FlutterSecureStorage().deleteAll();
      final previousFlutterError = FlutterError.onError;
      final previousErrorWidgetBuilder = ErrorWidget.builder;
      FlutterError.onError = (details) {
        debugPrint('Staff desktop smoke captured FlutterError:\n$details');
        previousFlutterError?.call(details);
      };
      addTearDown(() => FlutterError.onError = previousFlutterError);
      addTearDown(() => ErrorWidget.builder = previousErrorWidgetBuilder);

      app.main();

      await waitFor(
        tester,
        find.byType(TextFormField),
        reason: 'Login form did not render',
      );
      ErrorWidget.builder = previousErrorWidgetBuilder;

      await tester.enterText(find.byType(TextFormField).at(0), '1007');
      await tester.enterText(find.byType(TextFormField).at(1), 'test1234');
      await tester.tap(find.byType(ElevatedButton).last);

      await waitFor(
        tester,
        find.text('Daily Work'),
        timeout: const Duration(seconds: 30),
        reason: 'Dashboard did not render after staff login',
      );
      await waitFor(tester, find.text('More tools'));
      expectCleanScreen(tester, 'dashboard after login');

      final bottomNavLabels = ['Messages', 'Settings', 'Profile'];
      for (final label in bottomNavLabels) {
        await tapVisibleText(tester, label);
        expectCleanScreen(tester, 'bottom nav "$label"');
        await goHome(tester);
      }

      final featureLabels = [
        'Check In/Out',
        'Shift Schedule',
        'Appointments',
        'Appt Queue',
        'OP Patient Records',
        'Pharmacy (OP)',
        'Upload Results',
        'Lab Results (OP)',
        'Lab Bookings (OP)',
        'IP Services',
        'Bed Board',
        'IP Patient Records',
        'Pharmacy (IP)',
        'Upload Results',
        'Lab Results (IP)',
        'Lab Bookings (IP)',
        'Dietary',
        'Operating Theatre',
        'Radiology',
        'Blood Bank',
        'Leave',
        'HR Dashboard',
        'Staff Mgmt',
        'Performance',
        'My Tasks',
        'Staff Directory',
        'Messages',
        'Profile',
        'Settings',
      ];

      for (final label in featureLabels) {
        await goHome(tester);
        await tapDashboardItem(tester, label);
        expectCleanScreen(tester, 'dashboard feature "$label"');
      }
    },
    timeout: const Timeout(Duration(minutes: 8)),
  );
}
