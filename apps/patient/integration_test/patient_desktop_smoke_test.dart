import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:vhhealth/core/navigation/app_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  const storage = FlutterSecureStorage();

  Future<void> waitFor(
    WidgetTester tester,
    Finder finder, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      await tester.pump(const Duration(milliseconds: 250));
      if (finder.evaluate().isNotEmpty) return;
    }
    expect(finder, findsOneWidget);
  }

  Future<void> waitUntilAbsent(
    WidgetTester tester,
    Finder finder, {
    Duration timeout = const Duration(seconds: 5),
  }) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      await tester.pump(const Duration(milliseconds: 250));
      if (finder.evaluate().isNotEmpty) {
        continue;
      }
      return;
    }
    expect(finder, findsNothing);
  }

  Future<void> tapVisible(WidgetTester tester, Finder finder) async {
    await tester.ensureVisible(finder);
    await tester.pump(const Duration(milliseconds: 250));
    await tester.tap(finder);
    await tester.pump(const Duration(milliseconds: 500));
  }

  testWidgets(
    'desktop guest and dev login smoke',
    (tester) async {
      debugPrint('SMOKE: clearing local patient state');
      await storage.deleteAll();
      final prefs = await SharedPreferences.getInstance();
      await prefs.clear();
      await prefs.setString('language_code', 'en');
      await prefs.setString('theme_mode', 'light');

      debugPrint('SMOKE: starting app');
      app.main();

      debugPrint('SMOKE: waiting for login');
      await waitFor(tester, find.text('Login to your account'));
      debugPrint('SMOKE: login visible');
      expect(find.text('Get OTP'), findsOneWidget);
      expect(find.text('Continue as Guest'), findsOneWidget);
      expect(find.text('Dev login 1234567890'), findsOneWidget);
      expect(find.byTooltip('Light mode'), findsOneWidget);
      expect(find.byTooltip('Dark mode'), findsOneWidget);

      debugPrint('SMOKE: opening terms route');
      AppRouter.router.go('/terms', extra: {'section': 'terms'});
      await tester.pump(const Duration(milliseconds: 500));
      await waitFor(tester, find.text('Terms, Conditions & Privacy'));
      expect(find.text('Terms of Use'), findsAtLeastNWidgets(1));
      expect(
        find.textContaining('Welcome to VH Health', findRichText: true),
        findsAtLeastNWidgets(1),
      );
      AppRouter.router.go('/login');
      await waitFor(tester, find.text('Login to your account'));

      debugPrint('SMOKE: opening privacy route');
      AppRouter.router.go('/terms', extra: {'section': 'privacy'});
      await tester.pump(const Duration(milliseconds: 500));
      await waitFor(tester, find.text('Terms, Conditions & Privacy'));
      final privacyBody = find.textContaining('We collect', findRichText: true);
      await tester.scrollUntilVisible(
        privacyBody,
        400,
        scrollable: find.byType(Scrollable).last,
        maxScrolls: 20,
      );
      expect(privacyBody, findsAtLeastNWidgets(1));
      AppRouter.router.go('/login');
      await waitFor(tester, find.text('Login to your account'));

      debugPrint('SMOKE: guest login');
      await tapVisible(tester, find.text('Continue as Guest'));
      await waitFor(tester, find.text('there'));
      await tester.pump(const Duration(seconds: 5));
      expect(find.text('Login to your account'), findsNothing);

      debugPrint('SMOKE: guest trivia');
      await tapVisible(tester, find.text('Trivia').first);
      await waitFor(tester, find.text('Health Trivia'));
      expect(find.text('Did you know?'), findsOneWidget);
      AppRouter.router.go('/home');
      await waitFor(tester, find.text('there'));

      debugPrint('SMOKE: guest departments');
      await tapVisible(tester, find.text('Departments').first);
      await waitFor(tester, find.text('Hospital Departments'));
      expect(
        find.text('Unable to load departments. Please pull down to retry.'),
        findsNothing,
      );
      AppRouter.router.go('/home');
      await waitFor(tester, find.text('there'));

      debugPrint('SMOKE: guest protected nav returns to login');
      await tapVisible(tester, find.text('Your Health').last);
      await waitFor(tester, find.text('Login to your account'));

      debugPrint('SMOKE: dev login');
      await tapVisible(tester, find.text('Dev login 1234567890'));
      await waitFor(tester, find.textContaining('Hospital ID'));
      await waitUntilAbsent(tester, find.text('Login to your account'));
      debugPrint('SMOKE: complete');
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
