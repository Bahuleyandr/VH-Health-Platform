import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/pharmacy/widgets/inventory_disposal_sheet.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  testWidgets(
    'Schedule X disposal stays blocked until exact independent witness approval',
    (tester) async {
      Map<String, dynamic>? requestedWitnessIntent;
      Map<String, dynamic>? approvedWitnessIntent;
      Map<String, dynamic>? disposedIntent;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: InventoryDisposalSheet(
              facilityId: 8,
              item: const {
                'id': 501,
                'display_name': 'Schedule X medicine',
                'schedule_class': 'X',
                'is_narcotic': true,
              },
              loadBatches: (itemId, facilityId, status) async =>
                  status == 'in_stock'
                  ? [
                      {
                        'id': 601,
                        'inventory_item_id': itemId,
                        'facility_id': facilityId,
                        'batch_number': 'SX-601',
                        'lot_number': 'LOT-601',
                        'supplier_id': 41,
                        'expiry_date': '2027-08-30',
                        'remaining_quantity': 5,
                        'status': status,
                        'schedule_class': 'X',
                        'is_narcotic': true,
                      },
                    ]
                  : const [],
              requestWitnessApproval:
                  ({required disposal, required idempotencyKey}) async {
                    requestedWitnessIntent = disposal;
                    expect(
                      idempotencyKey,
                      startsWith('inventory-disposal-witness-request:'),
                    );
                    return {'id': '91', 'status': 'pending'};
                  },
              approveWitnessApproval:
                  ({
                    required approvalId,
                    required disposal,
                    required employeeId,
                    required password,
                    required idempotencyKey,
                  }) async {
                    expect(approvalId, '91');
                    expect(employeeId, 'PHARM-002');
                    expect(password, 'witness-secret');
                    expect(
                      idempotencyKey,
                      startsWith('inventory-disposal-witness-approval:'),
                    );
                    approvedWitnessIntent = disposal;
                    return {
                      'id': approvalId,
                      'status': 'approved',
                      'witness': {'name': 'Independent Pharmacy Staff'},
                    };
                  },
              disposeBatch:
                  ({required disposal, required idempotencyKey}) async {
                    expect(idempotencyKey, startsWith('inventory-disposal:'));
                    disposedIntent = disposal;
                    return {
                      'disposal': {'movement_id': 701},
                    };
                  },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('inventory-disposal-batch')));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('SX-601').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('inventory-disposal-quantity')),
        '2.5000',
      );
      await tester.enterText(
        find.byKey(const ValueKey('inventory-disposal-reason')),
        'damaged',
      );
      await tester.enterText(
        find.byKey(const ValueKey('inventory-disposal-method')),
        'authorized_incineration',
      );
      await tester.pump();

      expect(
        tester
            .widget<FilledButton>(
              find.byKey(const ValueKey('inventory-disposal-submit')),
            )
            .onPressed,
        isNull,
      );
      // The sheet is taller than the 800x600 test surface, so the witness
      // control sits below the fold and a bare tap() misses it.
      await tester.ensureVisible(
        find.byKey(const ValueKey('inventory-disposal-request-witness')),
      );
      await tester.pump();
      await tester.tap(
        find.byKey(const ValueKey('inventory-disposal-request-witness')),
      );
      // The sheet stays _busy for as long as the credentials dialog is open,
      // and _busy renders an indeterminate CircularProgressIndicator on the
      // submit control — pumpAndSettle can never settle against one. Pump the
      // dialog's entrance transition by hand instead.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(
        find.text(
          'Use a second active PHARMACY_STAFF or PHARMACY_INCHARGE operator who holds an ACTIVE grant for this exact selected facility. They must authenticate independently; the current operator cannot witness their own disposal.',
        ),
        findsOneWidget,
      );
      await tester.enterText(
        find.byKey(const ValueKey('inventory-disposal-witness-employee-id')),
        'pharm-002',
      );
      await tester.enterText(
        find.byKey(const ValueKey('inventory-disposal-witness-password')),
        'witness-secret',
      );
      await tester.tap(
        find.byKey(const ValueKey('inventory-disposal-witness-approve')),
      );
      // Same reason: pump the dialog's exit transition rather than settling.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(requestedWitnessIntent, approvedWitnessIntent);
      expect(
        tester
            .widget<FilledButton>(
              find.byKey(const ValueKey('inventory-disposal-submit')),
            )
            .onPressed,
        isNotNull,
      );
      await tester.tap(find.byKey(const ValueKey('inventory-disposal-submit')));
      await tester.pumpAndSettle();

      expect(disposedIntent, {
        'facility_id': 8,
        'inventory_item_id': 501,
        'inventory_batch_id': 601,
        'quantity': 2.5,
        'reason_code': 'damaged',
        'disposition_method': 'authorized_incineration',
        'witness_approval_id': '91',
      });
    },
  );

  test(
    'disposal localization has technical key parity for every shipped locale',
    () {
      const keys = [
        'pharmacy.disposal.title',
        'pharmacy.disposal.facility',
        'pharmacy.disposal.batch',
        'pharmacy.disposal.batch_constraints',
        'pharmacy.disposal.quantity',
        'pharmacy.disposal.reason_code',
        'pharmacy.disposal.method',
        'pharmacy.disposal.controlled_warning',
        'pharmacy.disposal.witness_title',
        'pharmacy.disposal.witness_hint',
        'pharmacy.disposal.witness_required',
        'pharmacy.disposal.submit',
        'pharmacy.disposal.completed',
      ];
      for (final locale in AppStrings.supportedLocales) {
        final strings = AppStrings.forLocale(locale);
        for (final key in keys) {
          expect(
            strings.lookup(key),
            isNot(key),
            reason: '${locale.languageCode} is missing $key',
          );
        }
      }
    },
  );

  test('facility-bound custody copy retains exact pharmacy roles and active grant state', () {
    const keys = [
      'pharmacy.order.controlled_witness_custody_hint',
      'pharmacy.disposal.witness_hint',
    ];
    final english = AppStrings.forLocale(const Locale('en'));

    for (final locale in AppStrings.supportedLocales) {
      final strings = AppStrings.forLocale(locale);
      for (final key in keys) {
        final message = strings.lookup(key);
        expect(message, contains('PHARMACY_STAFF'));
        expect(message, contains('PHARMACY_INCHARGE'));
        expect(message, contains('ACTIVE'));
        if (locale.languageCode != 'en') {
          expect(
            message,
            isNot(english.lookup(key)),
            reason:
                '${locale.languageCode} must not silently fall back to English for $key',
          );
        }
      }
    }
  });
}
