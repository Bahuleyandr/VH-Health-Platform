import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/models/composition_alternatives.dart';
import 'package:vhhealth_staff/features/pharmacy/widgets/composition_alternatives_panel.dart';

void main() {
  test('visibility gate requires a selected high-confidence catalog row', () {
    expect(
      shouldShowCompositionAlternativesPanel(
        catalogId: null,
        compositionConfidence: 'high',
      ),
      isFalse,
    );
    expect(
      shouldShowCompositionAlternativesPanel(
        catalogId: 1,
        compositionConfidence: 'medium',
      ),
      isFalse,
    );
    expect(
      shouldShowCompositionAlternativesPanel(
        catalogId: 1,
        compositionConfidence: 'HIGH',
      ),
      isTrue,
    );
  });

  testWidgets(
    'flag-off empty endpoint response renders byte-identical hidden UI',
    (tester) async {
      var calls = 0;
      await tester.pumpWidget(
        _host(
          CompositionAlternativesPanel(
            catalogId: 10,
            visible: true,
            doNotSubstitute: false,
            loader: (catalogId) async {
              calls += 1;
              return CompositionAlternativesResult.fromJson(const {
                'selected': null,
                'groups': [],
                'alternatives': [],
              });
            },
            onSwap: (_) {},
          ),
        ),
      );

      await tester.pumpAndSettle();

      expect(calls, 1);
      expect(find.text('Composition alternatives'), findsNothing);
      expect(find.text('Swap'), findsNothing);
    },
  );

  testWidgets(
    'groups alternatives in server order and swaps substitutable item',
    (tester) async {
      int? swappedCatalogId;
      await tester.pumpWidget(
        _host(
          CompositionAlternativesPanel(
            catalogId: 10,
            visible: true,
            doNotSubstitute: false,
            selectedLabel: 'Augmentin 625',
            loader: (_) async => _alternativesResult(),
            onSwap: (item) => swappedCatalogId = item.catalogId,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Composition alternatives'));
      await tester.pumpAndSettle();

      expect(find.text('625 mg / tablet - matched strength/form'), findsOne);
      expect(find.text('1 g / injection'), findsOne);
      expect(find.text('Info only'), findsOne);

      final clavamTop = tester.getTopLeft(find.text('Clavam 625')).dy;
      final moxTop = tester.getTopLeft(find.text('Moxikind 625')).dy;
      expect(clavamTop, lessThan(moxTop));

      await tester.tap(find.widgetWithText(TextButton, 'Swap').first);
      expect(swappedCatalogId, 11);
    },
  );

  testWidgets('DAW makes directly substitutable siblings information-only', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        CompositionAlternativesPanel(
          catalogId: 10,
          visible: true,
          doNotSubstitute: true,
          selectedLabel: 'Augmentin 625',
          loader: (_) async => _alternativesResult(),
          onSwap: (_) => fail('DAW panel must not swap'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Composition alternatives'));
    await tester.pumpAndSettle();

    expect(find.text('Swap'), findsNothing);
    expect(find.text('DAW locked'), findsWidgets);
  });
}

Widget _host(Widget child) {
  return MaterialApp(
    home: Scaffold(
      body: Padding(padding: const EdgeInsets.all(16), child: child),
    ),
  );
}

CompositionAlternativesResult _alternativesResult() {
  return CompositionAlternativesResult.fromJson(const {
    'selected': {
      'catalog_id': 10,
      'composition_id': 3,
      'composition_label': 'Amoxicillin + Clavulanic acid',
      'strength': '625 mg',
      'strength_key': '625mg',
      'form': 'tablet',
      'form_key': 'tablet',
      'release_key': 'ir',
    },
    'groups': [
      {
        'strength': '625 mg',
        'strength_key': '625mg',
        'form': 'tablet',
        'form_key': 'tablet',
        'matched': true,
        'items': [
          {
            'catalog_id': 11,
            'name': 'Clavam 625',
            'generic_name': 'Amoxicillin + Clavulanic acid',
            'manufacturer': 'Alpha',
            'strength': '625 mg',
            'strength_key': '625mg',
            'form': 'tablet',
            'form_key': 'tablet',
            'stock_quantity': 14,
            'availability_status': 'in_stock',
            'substitutable': true,
          },
          {
            'catalog_id': 12,
            'name': 'Moxikind 625',
            'generic_name': 'Amoxicillin + Clavulanic acid',
            'manufacturer': 'Beta',
            'strength': '625 mg',
            'strength_key': '625mg',
            'form': 'tablet',
            'form_key': 'tablet',
            'stock_quantity': null,
            'availability_status': 'may_be_available',
            'substitutable': true,
          },
        ],
      },
      {
        'strength': '1 g',
        'strength_key': '1g',
        'form': 'injection',
        'form_key': 'injection',
        'matched': false,
        'items': [
          {
            'catalog_id': 13,
            'name': 'Claventin IV',
            'generic_name': 'Amoxicillin + Clavulanic acid',
            'manufacturer': 'Gamma',
            'strength': '1 g',
            'strength_key': '1g',
            'form': 'injection',
            'form_key': 'injection',
            'stock_quantity': 0,
            'availability_status': 'out_of_stock',
            'substitutable': false,
          },
        ],
      },
    ],
    'alternatives': [],
  });
}
