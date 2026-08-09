import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsFlag;
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/outage/patient_outage_config.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/core/widgets/patient_outage_scope.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late PatientOutageController controller;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await PatientOutageConfigStore.instance.resetForTesting();
    controller = PatientOutageController.forTesting(
      request: () => throw StateError('network must not be used'),
      authentication: () async => 'patient-session',
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
    );
    controller.closeForTesting(PatientOutageReason.transportUnavailable);
    PatientOutageController.setForTesting(controller);
  });

  tearDown(() async {
    PatientOutageController.resetAfterTesting();
    controller.dispose();
    await PatientOutageConfigStore.instance.resetForTesting();
  });

  testWidgets(
    'renders the owner-approved bundled floor and blocked-action copy',
    (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          locale: Locale('en'),
          supportedLocales: AppLocalizations.supportedLocales,
          localizationsDelegates: [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: PatientOutageScope(child: Scaffold(body: Text('cached view'))),
        ),
      );

      expect(
        find.textContaining('Hospital systems are temporarily unavailable'),
        findsOneWidget,
      );
      expect(find.textContaining('[facility contact number]'), findsOneWidget);
      expect(find.text('cached view'), findsOneWidget);

      controller.reportBlockedMutation('POST', '/appointments');
      await tester.pump();

      expect(find.text('This request was not sent.'), findsOneWidget);
      expect(
        find.textContaining('Hospital systems are temporarily unavailable'),
        findsNWidgets(2),
      );
    },
  );

  testWidgets(
    'renders an outage banner from the MaterialApp builder without replacing the app',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1080, 2520));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(
        MaterialApp(
          locale: const Locale('en'),
          supportedLocales: AppLocalizations.supportedLocales,
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          builder: (context, child) =>
              PatientOutageScope(child: child ?? const SizedBox.shrink()),
          home: const Scaffold(body: Text('authenticated patient view')),
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.byType(ErrorWidget), findsNothing);
      expect(find.text('authenticated patient view'), findsOneWidget);
      expect(
        find.textContaining('Hospital systems are temporarily unavailable'),
        findsOneWidget,
      );

      controller.reportBlockedMutation('POST', '/appointments');
      await tester.pump();
      await tester.pump();
      // One more frame so the focus handed to the overlay's close button
      // (applied in a post-frame callback + focus microtask) reaches the
      // semantics tree.
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.byType(ErrorWidget), findsNothing);
      expect(find.text('This request was not sent.'), findsOneWidget);
      expect(
        tester.getSemantics(find.byType(IconButton)),
        matchesSemantics(
          label: 'Close',
          isButton: true,
          hasEnabledState: true,
          isEnabled: true,
          isFocusable: true,
          // The overlay close button autofocuses so keyboard/switch-access
          // users land inside the safety-critical notice.
          isFocused: true,
          hasFocusAction: true,
          hasTapAction: true,
        ),
      );
    },
  );

  testWidgets(
    'blocked SOS overlay is announced, modal to screen readers, and dismissible',
    (tester) async {
      final semantics = tester.ensureSemantics();
      await tester.binding.setSurfaceSize(const Size(1080, 2520));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(
        const MaterialApp(
          locale: Locale('en'),
          supportedLocales: AppLocalizations.supportedLocales,
          localizationsDelegates: [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: PatientOutageScope(child: Scaffold(body: Text('cached view'))),
        ),
      );
      await tester.pump();

      // Background content is reachable before the overlay appears.
      expect(find.semantics.byLabel('cached view'), findsOne);

      // A blocked emergency mutation — a failed SOS — raises the overlay.
      controller.reportBlockedMutation('POST', '/sos/');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      // The safety-critical failure text is present and is a live region,
      // so TalkBack/VoiceOver announce it when the overlay appears.
      expect(
        find.text('The hospital emergency alert was not sent.'),
        findsOneWidget,
      );
      expect(
        tester.getSemantics(
          find.bySemanticsLabel(
            RegExp('The hospital emergency alert was not sent'),
          ),
        ),
        isSemantics(isLiveRegion: true),
      );

      // The overlay presents itself as a route to assistive technology,
      // moving screen-reader focus into it.
      expect(find.semantics.byFlag(SemanticsFlag.scopesRoute), findsAtLeast(1));

      // The obscured app behind the scrim is blocked from the semantics
      // tree (still painted, but unreachable by traversal).
      expect(find.text('cached view'), findsOneWidget);
      expect(find.semantics.byLabel('cached view'), findsNothing);

      // Keyboard/switch-access focus lands on the close button.
      final closeFocus = Focus.of(tester.element(find.byIcon(Icons.close)));
      expect(closeFocus.hasPrimaryFocus, isTrue);

      // The overlay is dismissible from its labeled close button.
      await tester.tap(find.byIcon(Icons.close));
      await tester.pump();
      expect(
        find.text('The hospital emergency alert was not sent.'),
        findsNothing,
      );
      expect(find.semantics.byLabel('cached view'), findsOne);

      semantics.dispose();
    },
  );

  testWidgets('keeps the patient view mounted when the banner cannot build', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) =>
            PatientOutageScope(child: child ?? const SizedBox.shrink()),
        home: const Scaffold(body: Text('authenticated patient view')),
      ),
    );
    await tester.pump();

    expect(tester.takeException(), isNotNull);
    expect(find.text('authenticated patient view'), findsOneWidget);
    expect(find.byType(ErrorWidget), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
