import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/widgets/clinical_print_pdf_action.dart';

void main() {
  testWidgets('clinical print PDF action is hidden for draft documents', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ClinicalPrintPdfAction(
            visible: false,
            busy: false,
            onPressed: () {},
          ),
        ),
      ),
    );

    expect(find.text('Print / Share PDF'), findsNothing);
  });

  testWidgets('clinical print PDF action is visible for signed documents', (
    tester,
  ) async {
    var tapped = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ClinicalPrintPdfAction(
            visible: true,
            busy: false,
            onPressed: () => tapped = true,
          ),
        ),
      ),
    );

    expect(find.text('Print / Share PDF'), findsOneWidget);
    await tester.tap(find.text('Print / Share PDF'));
    expect(tapped, isTrue);
  });
}
