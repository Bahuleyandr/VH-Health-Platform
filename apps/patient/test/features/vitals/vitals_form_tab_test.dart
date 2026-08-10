import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/vitals/widgets/vitals_form_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets('patient form accepts the canonical peri-arrest boundaries', (
    tester,
  ) async {
    await tester.pumpWidget(_Harness(child: VitalsFormTab(onSubmitted: () {})));

    final fields = find.byType(TextFormField);
    await tester.enterText(fields.at(0), '0');
    await tester.enterText(fields.at(1), '0');
    await tester.enterText(fields.at(2), '0');
    await tester.enterText(fields.at(3), '53.6');
    await tester.enterText(fields.at(4), '0');
    await tester.enterText(fields.at(6), '0');

    expect(tester.state<FormState>(find.byType(Form)).validate(), isTrue);
  });

  testWidgets('patient form preserves the canonical upper guards', (
    tester,
  ) async {
    await tester.pumpWidget(_Harness(child: VitalsFormTab(onSubmitted: () {})));

    final fields = find.byType(TextFormField);
    await tester.enterText(fields.at(0), '301');
    await tester.enterText(fields.at(2), '301');
    await tester.enterText(fields.at(3), '113.1');
    await tester.enterText(fields.at(4), '1501');
    await tester.enterText(fields.at(6), '101');

    expect(tester.state<FormState>(find.byType(Form)).validate(), isFalse);
  });
}

class _Harness extends StatelessWidget {
  const _Harness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: child),
    );
  }
}
