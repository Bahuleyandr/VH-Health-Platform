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
