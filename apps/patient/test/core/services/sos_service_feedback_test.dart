import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/sos_api_service.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    SOSService.debugSetTriggerOverride(null);
  });

  testWidgets('SosException path shows user feedback instead of going silent', (
    tester,
  ) async {
    SOSService.debugSetTriggerOverride(([context]) async {
      throw const SosException('Emergency dispatch is unavailable');
    });

    await tester.pumpWidget(const _SosHarness());

    await tester.tap(find.text('Trigger SOS'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Emergency dispatch is unavailable'), findsOneWidget);
  });

  testWidgets('success is announced only after SOS dispatch completes', (
    tester,
  ) async {
    final dispatch = Completer<SosTriggerResult>();
    SOSService.debugSetTriggerOverride(([context]) => dispatch.future);

    await tester.pumpWidget(const _SosHarness());
    await tester.tap(find.text('Trigger SOS'));
    await tester.pump();

    expect(find.text('Sending SOS alert…'), findsOneWidget);
    expect(find.text('SOS alert has been triggered!'), findsNothing);

    dispatch.complete(
      const SosTriggerResult(
        backendOutcome: SosBackendOutcome.reported,
        dialerLaunched: true,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Sending SOS alert…'), findsNothing);
    expect(find.text('SOS alert has been triggered!'), findsOneWidget);
  });

  testWidgets(
    'failed backend outcome shows the SosException message, never the success '
    'toast (HIGH-1: core failures used to be swallowed)',
    (tester) async {
      SOSService.debugSetTriggerOverride(
        ([context]) async => const SosTriggerResult(
          backendOutcome: SosBackendOutcome.failed,
          dialerLaunched: true,
          error: SosException('Emergency dispatch is unavailable'),
        ),
      );

      await tester.pumpWidget(const _SosHarness());
      await tester.tap(find.text('Trigger SOS'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('SOS alert has been triggered!'), findsNothing);
      expect(find.text('Emergency dispatch is unavailable'), findsOneWidget);
    },
  );

  testWidgets('failed backend outcome without a clean message shows the honest '
      'failure copy that points at the phone-call safety net', (tester) async {
    SOSService.debugSetTriggerOverride(
      ([context]) async => SosTriggerResult(
        backendOutcome: SosBackendOutcome.failed,
        dialerLaunched: true,
        error: Exception('SocketException: connection refused'),
      ),
    );

    await tester.pumpWidget(const _SosHarness());
    await tester.tap(find.text('Trigger SOS'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('SOS alert has been triggered!'), findsNothing);
    expect(
      find.textContaining('the phone line is your backup'),
      findsOneWidget,
    );
  });

  testWidgets('guest skip does not claim "triggered" (no alert was sent)', (
    tester,
  ) async {
    SOSService.debugSetTriggerOverride(
      ([context]) async => const SosTriggerResult(
        backendOutcome: SosBackendOutcome.skipped,
        dialerLaunched: true,
      ),
    );

    await tester.pumpWidget(const _SosHarness());
    await tester.tap(find.text('Trigger SOS'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('SOS alert has been triggered!'), findsNothing);
    expect(find.textContaining('Emergency call opened'), findsOneWidget);
  });
}

class _SosHarness extends StatelessWidget {
  const _SosHarness();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: ElevatedButton(
              onPressed: () {
                SOSService.triggerWithFeedback(context);
              },
              child: const Text('Trigger SOS'),
            ),
          ),
        ),
      ),
    );
  }
}
