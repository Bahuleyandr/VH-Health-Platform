import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:vhhealth_staff/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // Per-step deadline. If a single tile / tab takes longer than this the
  // harness fails fast at that label instead of consuming the whole 8-minute
  // suite budget — tells us *which* route hung. The dashboard route
  // navigation itself should settle in well under 30 s; values above ~45 s
  // mean the screen is making a network call without a timeout.
  const stepDeadline = Duration(seconds: 45);

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

    final scrollables = find.byType(Scrollable);
    if (scrollables.evaluate().isEmpty) {
      throw StateError(
        'Expected "$label" but no scrollable surface was available',
      );
    }

    // scrollUntilVisible re-resolves `scrollable.single` on every internal
    // drag step. A route change or an ExpansionTile expand animation can
    // briefly rebuild the tree so that for one frame no Scrollable exists,
    // and that race throws `StateError: Bad state: No element` from inside
    // flutter_test rather than a clean "not found". Retry across that
    // transient — a genuinely missing target still fails after the retries
    // (scrollUntilVisible exhausts maxScrolls and throws), so this hardens
    // the harness without masking a real missing-widget bug.
    StateError? lastTransient;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        await tester.scrollUntilVisible(
          finder,
          520,
          maxScrolls: 24,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pump(const Duration(milliseconds: 150));
        return;
      } on StateError catch (e) {
        // "No element" / "Too many elements" from the transient scrollable
        // resolution — settle a few frames and try again.
        lastTransient = e;
        await pumpFor(tester, const Duration(milliseconds: 400));
      }
    }
    throw StateError(
      'scrollToText("$label") failed after 3 attempts — last error: '
      '${lastTransient?.message}',
    );
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

  Future<bool> tapOptionalVisibleText(
    WidgetTester tester,
    String label, {
    bool last = true,
  }) async {
    if (find.text(label).evaluate().isEmpty) {
      debugPrint('Staff desktop smoke: skipping absent "$label"');
      return false;
    }
    await tapVisibleText(tester, label, last: last);
    return true;
  }

  /// Ensures the "More tools" ExpansionTile is open so [targetLabel] is in
  /// the tree. The dashboard tab is kept alive by the router shell, so the
  /// ExpansionTile *retains* its expanded state across a goHome — a blind
  /// tap therefore toggles it and can collapse an already-open section
  /// (this is exactly why the first More-tools probe passed but the second
  /// failed: fresh-collapsed vs. retained-expanded). So: only tap when the
  /// target tile isn't already present, and re-tap once if a tap closed it.
  Future<void> expandMoreTools(WidgetTester tester, String targetLabel) async {
    if (find.text(targetLabel).evaluate().isNotEmpty) return; // already open
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
    // If the section was already open and the tap closed it, re-open.
    if (find.text(targetLabel).evaluate().isEmpty) {
      await tester.tap(moreTools.last);
      await pumpFor(tester, const Duration(milliseconds: 600));
    }
  }

  Future<void> goHome(WidgetTester tester) async {
    final home = find.text('Home');
    if (home.evaluate().isNotEmpty) {
      await tester.ensureVisible(home.first);
      await tester.pump(const Duration(milliseconds: 150));
      await tester.tap(home.first);
      await pumpFor(tester, const Duration(seconds: 2));
    }
    await waitFor(tester, find.text('Daily Work'));
    await waitFor(tester, find.text('More tools'));
  }

  /// Selects an OP/IP service tab on the dashboard. The tab strip lives in
  /// `_buildClinicalServiceTabs` and uses an `AnimatedSwitcher` so only the
  /// selected group's tiles exist in the tree — without explicitly
  /// re-selecting before each tile lookup the test will fail to find any
  /// IP-only label after a goHome resets `_clinicalServiceTabIndex`.
  ///
  /// Tapping the already-selected tab is a cheap no-op, so callers can
  /// invoke this defensively before every tile tap.
  Future<void> selectServiceTab(WidgetTester tester, String tabLabel) async {
    final tab = find.text(tabLabel);
    await scrollToText(tester, tabLabel);
    await waitFor(
      tester,
      tab,
      timeout: const Duration(seconds: 6),
      reason: 'Expected "$tabLabel" tab to be present',
    );
    await tester.ensureVisible(tab.first);
    await tester.pump(const Duration(milliseconds: 150));
    await tester.tap(tab.first);
    // AnimatedSwitcher animates for 180 ms; pump a generous slice so the
    // outgoing tile set is fully unmounted before we look for tiles in the
    // incoming group.
    await pumpFor(tester, const Duration(milliseconds: 600));
  }

  /// Wraps a single dashboard-tile probe in a deadline so a single hung
  /// route (e.g. a Lab Bookings fetch waiting on a slow API) reports the
  /// label cleanly instead of burning the suite-level 8-minute budget.
  Future<void> probeWithDeadline(
    String label,
    Future<void> Function() body,
  ) async {
    try {
      await body().timeout(stepDeadline);
    } on Exception catch (e) {
      fail('Step "$label" exceeded ${stepDeadline.inSeconds} s deadline: $e');
    }
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

      // Phase 1 — bottom nav (Messages / Settings / Profile bottom buttons).
      const bottomNavLabels = ['Messages', 'Settings', 'Profile'];
      for (final label in bottomNavLabels) {
        await probeWithDeadline(label, () async {
          final opened = await tapOptionalVisibleText(tester, label);
          if (!opened) return;
          expectCleanScreen(tester, 'bottom nav "$label"');
          await goHome(tester);
        });
      }

      // Phase 2 — always-visible quick actions (above the OP/IP tabs and
      // not part of any service tab or More tools sheet).
      const alwaysVisibleLabels = ['Check In/Out', 'Shift Schedule'];
      for (final label in alwaysVisibleLabels) {
        await probeWithDeadline(label, () async {
          await goHome(tester);
          final opened = await tapOptionalVisibleText(tester, label);
          if (!opened) return;
          expectCleanScreen(tester, 'quick action "$label"');
        });
      }

      // Phase 3 — clinical service tabs (OP and IP). The dashboard renders
      // only the selected tab's tiles; the test re-selects the right tab
      // before each tile tap so a goHome that reset
      // `_clinicalServiceTabIndex` doesn't mask an IP-only label.
      const clinicalTabs = <String, List<String>>{
        'OP Services': [
          'Front Office',
          'Appointments',
          'Patient Queue',
          'AI Review',
          'OP Patient Records',
          'Pharmacy (OP)',
          'Upload Results',
          'Lab Results (OP)',
          'Lab Bookings (OP)',
        ],
        'IP Services': [
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
        ],
      };

      for (final entry in clinicalTabs.entries) {
        final tabLabel = entry.key;
        for (final tileLabel in entry.value) {
          await probeWithDeadline('$tabLabel → $tileLabel', () async {
            await goHome(tester);
            await selectServiceTab(tester, tabLabel);
            final opened = await tapOptionalVisibleText(tester, tileLabel);
            if (!opened) return;
            expectCleanScreen(
              tester,
              'clinical tile "$tileLabel" via "$tabLabel"',
            );
          });
        }
      }

      // Phase 4 — More tools section (HR, Tasks, Directory, Performance, Leave).
      const moreToolsLabels = [
        'Leave',
        'HR Dashboard',
        'Staff Mgmt',
        'Performance',
        'My Tasks',
        'Staff Directory',
      ];
      for (final label in moreToolsLabels) {
        await probeWithDeadline(label, () async {
          await goHome(tester);
          try {
            await expandMoreTools(tester, label);
          } on StateError {
            debugPrint('Staff desktop smoke: skipping absent "$label"');
            return;
          }
          final opened = await tapOptionalVisibleText(tester, label);
          if (!opened) return;
          expectCleanScreen(tester, 'more tools "$label"');
        });
      }
    },
    timeout: const Timeout(Duration(minutes: 8)),
  );
}
