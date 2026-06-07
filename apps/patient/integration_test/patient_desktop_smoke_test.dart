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
      await waitFor(tester, find.text('Guest'));
      expect(find.byTooltip('Toggle theme'), findsOneWidget);
      expect(find.byTooltip('Toggle font size'), findsOneWidget);
      expect(find.byTooltip('Exit guest'), findsOneWidget);
      final viewHeight =
          tester.view.physicalSize.height / tester.view.devicePixelRatio;
      for (final label in const [
        'Your Health',
        'Appointments',
        'Pharmacy',
        'Investigations',
        'Ask a Doubt',
        'Trivia',
        'Departments',
        'About Us',
      ]) {
        expect(find.text(label), findsAtLeastNWidgets(1));
        expect(
          tester.getBottomRight(find.text(label).first).dy,
          lessThan(viewHeight),
        );
      }
      await tester.pump(const Duration(seconds: 5));
      expect(find.text('Login to your account'), findsNothing);

      debugPrint('SMOKE: guest trivia');
      await tapVisible(tester, find.text('Trivia').first);
      await waitFor(tester, find.text('Health Trivia'));
      expect(find.text('Did you know?'), findsOneWidget);
      AppRouter.router.go('/home');
      await waitFor(tester, find.text('Guest'));

      debugPrint('SMOKE: guest departments');
      await tapVisible(tester, find.text('Departments').first);
      await waitFor(tester, find.text('Hospital Departments'));
      expect(
        find.text('Unable to load departments. Please pull down to retry.'),
        findsNothing,
      );
      AppRouter.router.go('/home');
      await waitFor(tester, find.text('Guest'));

      debugPrint('SMOKE: guest protected nav opens sign-in dialog');
      await tapVisible(tester, find.text('Your Health').last);
      await waitFor(tester, find.text('Sign in to continue'));
      expect(find.text('Keep browsing'), findsOneWidget);
      await tester.tap(find.text('Keep browsing'));
      await waitFor(tester, find.text('Guest'));
      expect(find.text('Login to your account'), findsNothing);

      await tapVisible(tester, find.text('Your Health').last);
      await waitFor(tester, find.text('Sign in to continue'));
      await tester.tap(find.text('Sign in and return'));
      await waitFor(tester, find.text('Login to your account'));

      debugPrint('SMOKE: dev login');
      await tapVisible(tester, find.text('Dev login 1234567890'));
      await waitFor(tester, find.text('Your Health'));
      await waitUntilAbsent(tester, find.text('Login to your account'));

      debugPrint('SMOKE: prescriptions and consultations');
      AppRouter.router.go('/health', extra: {'tab': 4});
      await tester.pump(const Duration(milliseconds: 500));
      await waitFor(tester, find.textContaining('RX-'));
      AppRouter.router.go('/home');
      await waitFor(tester, find.textContaining('Hospital ID'));
      await waitFor(tester, find.text('TODAY'));
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('Today could not refresh'), findsNothing);
      final hasTodayCard = [
        find.textContaining('Prescription'),
        find.textContaining('Investigation'),
        find.textContaining('Lab result'),
        find.textContaining('Bill'),
        find.textContaining('Upload'),
        find.textContaining('Health points'),
        find.textContaining('Visit'),
        find.text('Book your next visit'),
        find.text('Upload a health record'),
        find.text('Find a department'),
      ].any((finder) => finder.evaluate().isNotEmpty);
      expect(hasTodayCard, isTrue, reason: 'Home should show Today cards');
      AppRouter.router.go('/health', extra: {'tab': 5});
      await tester.pump(const Duration(milliseconds: 500));
      await waitFor(tester, find.textContaining('test diagnosis'));
      expect(find.textContaining('Chief complaint: new test'), findsOneWidget);
      debugPrint('SMOKE: complete');
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
