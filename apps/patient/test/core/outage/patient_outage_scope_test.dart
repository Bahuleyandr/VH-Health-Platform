import 'package:flutter/material.dart';
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
          hasFocusAction: true,
          hasTapAction: true,
        ),
      );
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
