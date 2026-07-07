import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/dental/models/dental_models.dart';
import 'package:vhhealth_staff/features/dental/widgets/dental_entry_forms.dart';

Widget _wrap(Widget child) {
  return MaterialApp(
    home: Scaffold(
      body: Padding(padding: const EdgeInsets.all(16), child: child),
    ),
  );
}

void main() {
  testWidgets('finding form blocks invalid FDI teeth until corrected', (
    tester,
  ) async {
    DentalFindingDraft? submitted;

    await tester.pumpWidget(
      _wrap(
        DentalFindingEntryForm(
          initialTooth: '19',
          onSubmit: (draft) async => submitted = draft,
        ),
      ),
    );

    expect(find.text('Use FDI 11-48 or 51-85.'), findsOneWidget);
    final submit = tester.widget<FilledButton>(
      find.byKey(const ValueKey('dental-finding-submit')),
    );
    expect(submit.onPressed, isNull);

    await tester.enterText(
      find.byKey(const ValueKey('dental-finding-tooth')),
      '36',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('dental-finding-submit')));
    await tester.pump();

    expect(submitted?.toothFdi, '36');
    expect(submitted?.finding, dentalFindingTypes.first);
  });

  testWidgets('procedure form requires a name and preserves linked finding', (
    tester,
  ) async {
    DentalProcedureDraft? submitted;
    const linkedFinding = DentalFinding(
      id: 42,
      toothFdi: '46',
      finding: 'caries',
      surface: 'occlusal',
    );

    await tester.pumpWidget(
      _wrap(
        DentalProcedureEntryForm(
          linkedFinding: linkedFinding,
          onSubmit: (draft) async => submitted = draft,
        ),
      ),
    );

    var submit = tester.widget<FilledButton>(
      find.byKey(const ValueKey('dental-procedure-submit')),
    );
    expect(submit.onPressed, isNull);

    await tester.enterText(
      find.byKey(const ValueKey('dental-procedure-name')),
      'Composite restoration',
    );
    await tester.pump();
    submit = tester.widget<FilledButton>(
      find.byKey(const ValueKey('dental-procedure-submit')),
    );
    expect(submit.onPressed, isNotNull);

    await tester.tap(find.byKey(const ValueKey('dental-procedure-submit')));
    await tester.pump();

    expect(submitted?.procedureName, 'Composite restoration');
    expect(submitted?.toothFdi, '46');
    expect(submitted?.surface, 'occlusal');
    expect(submitted?.findingId, 42);
  });
}
