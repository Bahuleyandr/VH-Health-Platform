import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/ipd/screens/drug_chart_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('free text cannot pass the drug-chart save boundary', () {
    expect(
      validateDrugChartDraft(
        drug: 'Paracetamol 650 mg',
        catalogId: null,
        dose: '650 mg',
        doseTimes: const ['morning'],
      ),
      DrugChartDraftValidationFailure.catalogSelectionRequired,
    );
    expect(
      validateDrugChartDraft(
        drug: 'Paracetamol 650 mg',
        catalogId: 41,
        dose: '650 mg',
        doseTimes: const ['morning'],
      ),
      isNull,
    );
  });

  Widget host({required DrugCatalogSearch search}) {
    return MaterialApp(
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: AppStrings.supportedLocales,
      home: Scaffold(
        body: DrugCatalogSearchField(
          controller: TextEditingController(),
          search: search,
          onSelected: (_) {},
        ),
      ),
    );
  }

  testWidgets('catalog failure shows unavailable state and no drug fallback', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(search: (_) async => throw StateError('catalog offline')),
    );

    await tester.enterText(find.byType(TextField), 'para');
    await tester.pump(const Duration(milliseconds: 260));
    await tester.pump();

    expect(find.text('Catalog unavailable'), findsOneWidget);
    expect(find.textContaining('Paracetamol'), findsNothing);
    expect(find.byType(ListTile), findsNothing);
  });

  testWidgets('only canonical catalog rows become selectable suggestions', (
    tester,
  ) async {
    Map<String, dynamic>? selected;
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: AppStrings.supportedLocales,
        home: Scaffold(
          body: DrugCatalogSearchField(
            controller: controller,
            search: (_) async => [
              {
                'name': 'Paracetamol Legacy Text',
                'strength': '500 mg',
                'form': 'tablet',
              },
              {
                'catalog_id': 41,
                'name': 'Paracetamol',
                'strength': '650 mg',
                'form': 'tablet',
              },
            ],
            onSelected: (row) => selected = row,
          ),
        ),
      ),
    );

    await tester.enterText(find.byType(TextField), 'para');
    await tester.pump(const Duration(milliseconds: 260));
    await tester.pump();
    await tester.tap(find.textContaining('Paracetamol').first);
    await tester.pump();

    expect(selected?['catalog_id'], 41);
    expect(controller.text, contains('Paracetamol'));
    expect(controller.text, isNot(contains('Legacy Text')));
  });
}
