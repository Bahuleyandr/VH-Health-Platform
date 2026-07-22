import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/models/composition_alternatives.dart';
import 'package:vhhealth_staff/features/pharmacy/widgets/dispense_substitution_sheet.dart';

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: child));

CompositionAlternativesResult _alts() =>
    CompositionAlternativesResult.fromJson(const {
      'selected': {
        'catalog_id': 101,
        'composition_id': 3,
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
              'catalog_id': 202,
              'name': 'Clavam 625',
              'manufacturer': 'Alkem',
              'strength': '625 mg',
              'strength_key': '625mg',
              'form': 'tablet',
              'form_key': 'tablet',
              'stock_quantity': 14,
              'availability_status': 'in_stock',
              'substitutable': true,
            },
          ],
        },
      ],
      'alternatives': [
        {
          'catalog_id': 202,
          'name': 'Clavam 625',
          'availability_status': 'in_stock',
          'substitutable': true,
        },
      ],
    });

void main() {
  testWidgets(
    'full flow: load context → swap → batch → dispense with correct args',
    (tester) async {
      Map<String, dynamic>? captured;
      await tester.pumpWidget(
        _host(
          DispenseSubstitutionSheet(
            orderId: 7,
            contextLoader: (id) async => {
              'order_id': id,
              'patient_uid': 'p-uid-1',
              'lines': [
                {'catalog_id': 101, 'name': 'Augmentin 625', 'quantity': 10},
              ],
            },
            alternativesLoader: (catalogId) async => _alts(),
            batchLoader: (catalogId) async => [
              {
                'inventory_item_id': 55,
                'inventory_batch_id': 900,
                'batch_number': 'B-NEAR',
                'remaining_quantity': 50,
                'expiry_date': '2027-01-01',
              },
            ],
            dispenser:
                ({
                  required patientUid,
                  encounterId,
                  required inventoryItemId,
                  required inventoryBatchId,
                  required quantity,
                  required originalCatalogId,
                  required finalCatalogId,
                  reason,
                }) async {
                  captured = {
                    'patientUid': patientUid,
                    'inventoryItemId': inventoryItemId,
                    'inventoryBatchId': inventoryBatchId,
                    'quantity': quantity,
                    'originalCatalogId': originalCatalogId,
                    'finalCatalogId': finalCatalogId,
                  };
                },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Augmentin 625'),
        findsWidgets,
      ); // prescribed line surfaced

      // Expand the alternatives panel, then swap to the equivalent brand.
      await tester.tap(find.text('Composition alternatives'));
      await tester.pumpAndSettle();
      final swapBtn = find.widgetWithText(TextButton, 'Swap').first;
      await tester.ensureVisible(swapBtn);
      await tester.pumpAndSettle();
      await tester.tap(swapBtn);
      await tester
          .pumpAndSettle(); // onSwap → batchLoader → batch picker + enabled dispense

      final dispenseBtn = find.widgetWithText(
        FilledButton,
        'Dispense substitute',
      );
      await tester.ensureVisible(dispenseBtn);
      await tester.pumpAndSettle();
      await tester.tap(dispenseBtn);
      await tester.pumpAndSettle();

      expect(captured, isNotNull);
      expect(captured!['patientUid'], 'p-uid-1');
      expect(captured!['originalCatalogId'], 101); // the prescribed brand
      expect(captured!['finalCatalogId'], 202); // the chosen substitute
      expect(captured!['inventoryItemId'], 55);
      expect(captured!['inventoryBatchId'], 900);
      expect(captured!['quantity'], 10); // defaulted from the prescribed line
    },
  );

  testWidgets(
    'no prescribed catalog lines → shows the cannot-resolve message',
    (tester) async {
      await tester.pumpWidget(
        _host(
          DispenseSubstitutionSheet(
            orderId: 8,
            contextLoader: (id) async => {
              'order_id': id,
              'patient_uid': 'p',
              'lines': const [],
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.textContaining('No prescribed catalog lines'),
        findsOneWidget,
      );
    },
  );
}
