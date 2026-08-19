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
                  witnessApprovalId,
                }) async {
                  captured = {
                    'patientUid': patientUid,
                    'inventoryItemId': inventoryItemId,
                    'inventoryBatchId': inventoryBatchId,
                    'quantity': quantity,
                    'originalCatalogId': originalCatalogId,
                    'finalCatalogId': finalCatalogId,
                    'witnessApprovalId': witnessApprovalId,
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
      await tester.pumpAndSettle(); // onSwap → batchLoader → batch picker + enabled dispense

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
      // Non-controlled batch: no witness approval attached.
      expect(captured!['witnessApprovalId'], isNull);
    },
  );

  testWidgets(
    'Schedule X batch: dispense stays disabled until the two-person witness '
    'flow completes, then sends the approval id',
    (tester) async {
      Map<String, dynamic>? captured;
      Map<String, dynamic>? requestedSubstitution;
      Map<String, dynamic>? approvedSubstitution;
      String? approvedEmployeeId;
      await tester.pumpWidget(
        _host(
          DispenseSubstitutionSheet(
            orderId: 9,
            contextLoader: (id) async => {
              'order_id': id,
              'patient_uid': 'p-uid-2',
              'lines': [
                {'catalog_id': 101, 'name': 'Augmentin 625', 'quantity': 5},
              ],
            },
            alternativesLoader: (catalogId) async => _alts(),
            batchLoader: (catalogId) async => [
              {
                'inventory_item_id': 66,
                'inventory_batch_id': 901,
                'batch_number': 'B-X',
                'remaining_quantity': 30,
                'expiry_date': '2027-01-01',
                'schedule_class': 'X',
                'is_narcotic': true,
              },
            ],
            requestWitnessApproval:
                ({required substitution, required idempotencyKey}) async {
                  requestedSubstitution = substitution;
                  return {'id': '41', 'status': 'pending'};
                },
            approveWitnessApproval:
                ({
                  required approvalId,
                  required substitution,
                  required employeeId,
                  required password,
                  required idempotencyKey,
                }) async {
                  approvedSubstitution = substitution;
                  approvedEmployeeId = employeeId;
                  return {
                    'id': approvalId,
                    'status': 'approved',
                    'witness': {'name': 'Roster Witness'},
                  };
                },
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
                  witnessApprovalId,
                }) async {
                  captured = {
                    'inventoryItemId': inventoryItemId,
                    'witnessApprovalId': witnessApprovalId,
                  };
                },
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Composition alternatives'));
      await tester.pumpAndSettle();
      final swapBtn = find.widgetWithText(TextButton, 'Swap').first;
      await tester.ensureVisible(swapBtn);
      await tester.pumpAndSettle();
      await tester.tap(swapBtn);
      await tester.pumpAndSettle();

      // Controlled batch → the dispense button is disabled pre-witness.
      final dispenseBtn = find.widgetWithText(
        FilledButton,
        'Dispense substitute',
      );
      await tester.ensureVisible(dispenseBtn);
      await tester.pumpAndSettle();
      expect(
        tester.widget<FilledButton>(dispenseBtn).onPressed,
        isNull,
        reason: 'Schedule X substitute must not be dispensable pre-witness',
      );

      // Run the witness flow: request, then sign in as the second staff.
      final witnessBtn = find.byKey(
        const ValueKey('substitution-witness-request'),
      );
      await tester.ensureVisible(witnessBtn);
      await tester.pumpAndSettle();
      await tester.tap(witnessBtn);
      // The credentials dialog is up while _witnessBusy still animates the
      // request button's indeterminate spinner, so pumpAndSettle would never
      // settle here — bounded pumps, same as counter_sale_screen_test.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(requestedSubstitution, isNotNull);
      expect(requestedSubstitution!['inventory_item_id'], 66);
      expect(requestedSubstitution!['final_catalog_id'], 202);
      expect(
        requestedSubstitution!.containsKey('witness_approval_id'),
        isFalse,
      );

      await tester.enterText(
        find.byKey(const ValueKey('substitution-witness-employee-id')),
        'emp-9',
      );
      await tester.enterText(
        find.byKey(const ValueKey('substitution-witness-password')),
        'secret',
      );
      await tester.tap(
        find.byKey(const ValueKey('substitution-witness-approve-submit')),
      );
      await tester.pumpAndSettle();
      expect(approvedEmployeeId, 'EMP-9');
      expect(approvedSubstitution, equals(requestedSubstitution));
      expect(find.textContaining('Roster Witness'), findsOneWidget);

      // Now the dispense goes through and carries the approval id.
      await tester.ensureVisible(dispenseBtn);
      await tester.pumpAndSettle();
      await tester.tap(dispenseBtn);
      await tester.pumpAndSettle();
      expect(captured, isNotNull);
      expect(captured!['witnessApprovalId'], '41');
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
