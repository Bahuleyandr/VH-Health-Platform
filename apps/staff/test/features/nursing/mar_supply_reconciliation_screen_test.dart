import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/nursing/screens/mar_supply_reconciliation_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  test('filters only unmatched consumption with outstanding quantity', () {
    expect(
      openMarSupplyConsumptions({
        'consumptions': [
          {
            'id': 'open',
            'evidence_status': 'unmatched_override',
            'quantity': 2,
            'reconciled_quantity': 0.5,
          },
          {
            'id': 'closed',
            'evidence_status': 'unmatched_override',
            'quantity': 1,
            'reconciled_quantity': 1,
          },
          {
            'id': 'matched',
            'evidence_status': 'matched',
            'quantity': 1,
            'reconciled_quantity': 0,
          },
        ],
      }).map((row) => row['id']),
      ['open'],
    );
  });

  test(
    'batch eligibility reasons are localized without rendering wire codes',
    () {
      for (final locale in const ['en', 'hi', 'ta', 'te', 'ml']) {
        final strings = AppStrings.forLocale(Locale(locale));
        for (final code in const [
          'inventory_item_inactive',
          'batch_reserved',
          'batch_depleted',
          'batch_expired',
          'batch_recalled',
          'batch_quarantined',
          'batch_disposed',
          'batch_status_missing',
          'ward_custody_unavailable',
          'batch_expiry_missing',
          'future_backend_reason',
        ]) {
          final label = localizedMarSupplyBatchEligibilityReason(strings, code);
          expect(label, isNot(code), reason: '$locale rendered raw $code');
          expect(label, isNot(startsWith('mar_supply.')));
        }
      }
    },
  );

  testWidgets('explains an ineligible batch and keeps its quantity disabled', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => ThemeProvider(),
        child: MaterialApp(
          home: MarSupplyReconciliationScreen(
            maId: 42,
            loadState: (_) async => {
              'consumptions': [
                {
                  'id': '9007199254740993',
                  'evidence_status': 'unmatched_override',
                  'quantity': 1,
                  'reconciled_quantity': 0,
                },
              ],
              'allocations': [
                {
                  'id': '101',
                  'display_name': 'Recalled Batch',
                  'batch_number': 'R-1',
                  'available_quantity': 1,
                  'batch_eligible': false,
                  'batch_eligibility_reason': 'batch_recalled',
                },
                {
                  'id': '102',
                  'display_name': 'Expired Batch',
                  'batch_number': 'E-1',
                  'available_quantity': 1,
                  'batch_eligible': false,
                  'batch_unavailable_reason': 'batch_expired',
                },
              ],
            },
            reconcile: ({
              required maId,
              required consumptionId,
              required allocations,
              required idempotencyKey,
            }) async => const {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('The batch was recalled and cannot be used.'), findsOne);
    expect(find.text('The batch has expired.'), findsOne);
    final compatibilityField = tester.widget<TextField>(
      find.byKey(const Key('mar-supply-allocation-101')),
    );
    final canonicalField = tester.widget<TextField>(
      find.byKey(const Key('mar-supply-allocation-102')),
    );
    expect(compatibilityField.enabled, isFalse);
    expect(canonicalField.enabled, isFalse);
  });

  testWidgets('disables allocation mutation while offline', (tester) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(ConnectivitySyncService.instance.resetForTesting);
    ConnectivitySyncService.instance.setTransportAvailableForTesting(false);
    var reconcileCalls = 0;

    await tester.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => ThemeProvider(),
        child: MaterialApp(
          home: MarSupplyReconciliationScreen(
            maId: 42,
            loadState: (_) async => {
              'consumptions': [
                {
                  'id': '9007199254740993',
                  'evidence_status': 'unmatched_override',
                  'quantity': 1,
                  'reconciled_quantity': 0,
                },
              ],
              'allocations': [
                {
                  'id': '101',
                  'display_name': 'Batch A',
                  'batch_number': 'A-1',
                  'available_quantity': 1,
                  'batch_eligible': true,
                },
              ],
            },
            reconcile:
                ({
                  required maId,
                  required consumptionId,
                  required allocations,
                  required idempotencyKey,
                }) async {
                  reconcileCalls += 1;
                  return const {};
                },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      tester
          .widget<TextField>(find.byKey(const Key('mar-supply-allocation-101')))
          .enabled,
      isFalse,
    );
    expect(
      tester
          .widget<FilledButton>(
            find.byKey(const Key('mar-supply-reconcile-submit')),
          )
          .onPressed,
      isNull,
    );
    expect(reconcileCalls, 0);
  });

  testWidgets(
    'submits exact allocation quantities and reuses key after ambiguous error',
    (tester) async {
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      var loadCalls = 0;
      var reconcileCalls = 0;
      final keys = <String>[];
      List<Map<String, dynamic>>? submitted;

      Future<Map<String, dynamic>> load(int _) async {
        loadCalls += 1;
        if (loadCalls > 1) {
          return const {'consumptions': [], 'allocations': []};
        }
        return {
          'consumptions': [
            {
              'id': '9007199254740993',
              'evidence_status': 'unmatched_override',
              'quantity': 2,
              'reconciled_quantity': 0,
            },
          ],
          'allocations': [
            {
              'id': '101',
              'display_name': 'Batch A',
              'batch_number': 'A-1',
              'available_quantity': 1.25,
              'batch_eligible': true,
            },
            {
              'id': '102',
              'display_name': 'Batch B',
              'batch_number': 'B-1',
              'available_quantity': 0.75,
              'batch_eligible': true,
            },
          ],
        };
      }

      await tester.pumpWidget(
        ChangeNotifierProvider(
          create: (_) => ThemeProvider(),
          child: MaterialApp(
            home: MarSupplyReconciliationScreen(
              maId: 42,
              loadState: load,
              reconcile:
                  ({
                    required maId,
                    required consumptionId,
                    required allocations,
                    required idempotencyKey,
                  }) async {
                    reconcileCalls += 1;
                    keys.add(idempotencyKey);
                    submitted = allocations;
                    expect(maId, 42);
                    expect(consumptionId, '9007199254740993');
                    if (reconcileCalls == 1) {
                      throw Exception('transport result unknown');
                    }
                    return {'task_completed': true};
                  },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('mar-supply-allocation-101')),
        '1.25',
      );
      await tester.enterText(
        find.byKey(const Key('mar-supply-allocation-102')),
        '0.75',
      );
      await tester.tap(find.byKey(const Key('mar-supply-reconcile-submit')));
      await tester.pumpAndSettle();

      expect(reconcileCalls, 1);
      expect(submitted, [
        {'inventory_allocation_id': '101', 'quantity': 1.25},
        {'inventory_allocation_id': '102', 'quantity': 0.75},
      ]);

      await tester.tap(find.byKey(const Key('mar-supply-reconcile-submit')));
      await tester.pumpAndSettle();

      expect(reconcileCalls, 2);
      expect(keys, hasLength(2));
      expect(keys[1], keys[0]);
      expect(find.text('No unmatched MAR supply override remains.'), findsOne);
    },
  );
}
