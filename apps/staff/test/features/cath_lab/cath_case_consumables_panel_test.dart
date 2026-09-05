import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/cath_lab/models/cath_consumable_models.dart';
import 'package:vhhealth_staff/features/cath_lab/services/cath_lab_api_service.dart';
import 'package:vhhealth_staff/features/cath_lab/widgets/cath_case_consumables_panel.dart';
import 'package:vhhealth_staff/features/cath_lab/widgets/cath_reuse_restriction_strip.dart';

const _cathCase = CathLabCaseSummary(
  id: 42,
  patientUid: '11111111-1111-4111-8111-111111111111',
  patientName: 'Asha Rao',
  requestedProcedure: 'Primary PCI',
  status: 'in_progress',
  urgency: 'emergency',
  labRoom: 'CL-1',
  plannedStartAt: null,
  readinessTotal: 8,
  readinessCleared: 8,
  procedureCount: 1,
  doseRecordCount: 1,
  activePostOrderCount: 0,
  deviceLinkCount: 1,
);

const _untrackedItem = CathConsumableCatalogItem(
  id: 10,
  itemName: 'Diagnostic catheter',
  category: 'catheter',
  manufacturer: 'Synthetic Medical',
  model: 'DX-5F',
  isImplant: false,
  batchTracked: false,
);

const _trackedImplant = CathConsumableCatalogItem(
  id: 17,
  itemName: 'Drug-eluting stent',
  category: 'stent',
  manufacturer: 'Synthetic Medical',
  model: 'DES-30',
  isImplant: true,
  batchTracked: true,
  inventoryItemId: 91,
  skuCode: 'CATH-DES-30',
);

const _batch = CathInventoryBatch(
  id: 44,
  inventoryItemId: 91,
  batchNumber: 'B-2026-07',
  lotNumber: 'LOT-7',
  expiryDate: null,
  remainingQuantity: 2,
  status: 'in_stock',
);

Widget _wrap(
  CathConsumableDependencies dependencies, {
  CathLabCaseSummary cathCase = _cathCase,
}) {
  return MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: CathCaseConsumablesPanel(
          cathCase: cathCase,
          initiallyExpanded: true,
          dependencies: dependencies,
        ),
      ),
    ),
  );
}

Widget _wrapReadOnly(CathConsumableDependencies dependencies) {
  return MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: CathCaseConsumablesPanel(
          cathCase: _cathCase,
          initiallyExpanded: true,
          canAddUsage: false,
          dependencies: dependencies,
        ),
      ),
    ),
  );
}

// Both loaders assert the ACTIVE case id reaches the API layer: the backend
// pins the facility from that case, so a catalog or batch read without it can
// never be authorised.
Future<List<CathConsumableCatalogItem>> _untrackedSearch({
  required int caseId,
  String? query,
  String? scan,
}) async {
  expect(caseId, greaterThan(0));
  return const [_untrackedItem];
}

Future<List<CathConsumableCatalogItem>> _trackedSearch({
  required int caseId,
  String? query,
  String? scan,
}) async {
  expect(caseId, greaterThan(0));
  return const [_trackedImplant];
}

void main() {
  testWidgets('ready cases open capture in locked wastage-only mode', (
    tester,
  ) async {
    const readyCase = CathLabCaseSummary(
      id: 43,
      patientUid: '11111111-1111-4111-8111-111111111111',
      patientName: 'Asha Rao',
      requestedProcedure: 'Primary PCI',
      status: 'ready',
      urgency: 'emergency',
      labRoom: 'CL-1',
      plannedStartAt: null,
      readinessTotal: 8,
      readinessCleared: 8,
      procedureCount: 0,
      doseRecordCount: 0,
      activePostOrderCount: 0,
      deviceLinkCount: 0,
    );
    await tester.pumpWidget(
      _wrap(
        CathConsumableDependencies(
          loadUsage: (_) async => const [],
          searchCatalog: _untrackedSearch,
          loadBatches: (_, {required caseId}) async => const [],
        ),
        cathCase: readyCase,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumables-add-43')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('cath-consumable-search')),
      'diagnostic',
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumable-option-10')));
    await tester.pumpAndSettle();

    final toggle = tester.widget<SwitchListTile>(
      find.byKey(const ValueKey('cath-consumable-wastage-toggle')),
    );
    expect(toggle.value, isTrue);
    expect(toggle.onChanged, isNull);
    expect(
      find.byKey(const ValueKey('cath-consumable-wastage-reason')),
      findsOneWidget,
    );
  });

  testWidgets('read-only cath roles cannot open consumable capture', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrapReadOnly(
        CathConsumableDependencies(loadUsage: (_) async => const []),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('cath-consumables-add-42')), findsNothing);
  });

  testWidgets('batch controls stay hidden for non-batch-tracked items', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        CathConsumableDependencies(
          loadUsage: (_) async => const [],
          searchCatalog: _untrackedSearch,
          loadBatches: (_, {required caseId}) async => const [],
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('cath-consumables-add-42')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('cath-consumable-search')),
      'diagnostic',
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumable-option-10')));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('cath-consumable-batch-picker')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('cath-consumable-manual-batch')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('cath-consumable-serial-number')),
      findsNothing,
    );
  });

  testWidgets(
    'tracked implant capture shows batch and wastage fields and keeps warning usage',
    (tester) async {
      CathConsumableUsageDraft? submitted;
      String? submittedIdempotencyKey;
      CathCaseConsumableUsage? created;
      final batch = CathInventoryBatch(
        id: _batch.id,
        inventoryItemId: _batch.inventoryItemId,
        batchNumber: _batch.batchNumber,
        lotNumber: _batch.lotNumber,
        expiryDate: DateTime(2028, 6, 30),
        remainingQuantity: _batch.remainingQuantity,
        status: _batch.status,
      );
      await tester.pumpWidget(
        _wrap(
          CathConsumableDependencies(
            // The panel re-reads the case after a capture — the POST response
            // is undecorated, so a spliced row would never carry its post-use
            // options — which means the listing has to show what was created.
            loadUsage: (_) async => created == null
                ? const []
                : <CathCaseConsumableUsage>[created!],
            searchCatalog: _trackedSearch,
            loadBatches: (_, {required caseId}) async {
              expect(caseId, 42);
              return [batch];
            },
            scanCode: () async => 'CATH-DES-30',
            createUsage: (caseId, draft, {required idempotencyKey}) async {
              expect(caseId, 42);
              // The route hard-400s without this header; pin that the capture
              // sheet actually mints one rather than relying on the default.
              expect(idempotencyKey, isNotEmpty);
              expect(idempotencyKey.length, lessThanOrEqualTo(200));
              submittedIdempotencyKey = idempotencyKey;
              submitted = draft;
              created = CathCaseConsumableUsage(
                id: 71,
                caseId: 42,
                catalogItemId: 17,
                itemName: _trackedImplant.itemName,
                category: _trackedImplant.category,
                quantity: draft.quantity,
                unitLabel: 'each',
                batchNumber: draft.batchNumber ?? '',
                lotNumber: draft.lotNumber ?? '',
                expiryDate: draft.expiryDate,
                serialNumber: draft.serialNumber ?? '',
                wasted: draft.wasted,
                wastageReason: draft.wastageReason ?? '',
                usedByName: 'Dr Test',
                isImplant: true,
                batchTracked: true,
                inventoryWarning: 'Insufficient stock; documentation retained',
                inventoryDecrementStatus: 'warning',
              );
              return created!;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('cath-consumables-add-42')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('cath-consumable-search')),
        'stent',
      );
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cath-consumable-option-17')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('cath-consumable-batch-picker')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('cath-consumable-serial-number')),
        findsOneWidget,
      );

      await tester.tap(
        find.byKey(const ValueKey('cath-consumable-batch-picker')),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.text('Batch B-2026-07 - expires 2028-06-30 - 2 remaining').last,
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('cath-consumable-serial-number')),
        'SER-1001',
      );
      await tester.ensureVisible(
        find.byKey(const ValueKey('cath-consumable-wastage-toggle')),
      );
      await tester.tap(
        find.byKey(const ValueKey('cath-consumable-wastage-toggle')),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('cath-consumable-wastage-reason')),
        'Opened but deployment aborted',
      );
      await tester.drag(find.byType(ListView).last, const Offset(0, -500));
      await tester.pumpAndSettle();
      final save = find.byKey(const ValueKey('cath-consumable-save'));
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pumpAndSettle();

      expect(submitted, isNotNull);
      expect(submittedIdempotencyKey, isNotNull);
      expect(submittedIdempotencyKey, startsWith('cath-consumable-usage:'));
      expect(submitted!.inventoryBatchId, 44);
      expect(submitted!.batchNumber, 'B-2026-07');
      expect(submitted!.lotNumber, 'LOT-7');
      expect(submitted!.serialNumber, 'SER-1001');
      expect(submitted!.wasted, isTrue);
      expect(submitted!.wastageReason, 'Opened but deployment aborted');
      expect(
        find.byKey(const ValueKey('cath-consumable-usage-71')),
        findsOneWidget,
      );
      expect(
        find.text('Insufficient stock; documentation retained'),
        findsWidgets,
      );
      expect(find.textContaining('Usage recorded.'), findsOneWidget);
    },
  );

  testWidgets('batch-tracked item without stock exposes manual batch fields', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        CathConsumableDependencies(
          loadUsage: (_) async => const [],
          searchCatalog: _trackedSearch,
          loadBatches: (_, {required caseId}) async => const [],
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumables-add-42')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('cath-consumable-search')),
      'stent',
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumable-option-17')));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('cath-consumable-batch-picker')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('cath-consumable-manual-batch')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('cath-consumable-manual-expiry')),
      findsOneWidget,
    );
  });

  testWidgets('injected scanner resolves the inventory SKU through catalog', (
    tester,
  ) async {
    String? scannedQuery;
    int? scannedCaseId;
    Future<List<CathConsumableCatalogItem>> scanSearch({
      required int caseId,
      String? query,
      String? scan,
    }) async {
      scannedCaseId = caseId;
      scannedQuery = scan;
      return const [_untrackedItem];
    }

    await tester.pumpWidget(
      _wrap(
        CathConsumableDependencies(
          loadUsage: (_) async => const [],
          searchCatalog: scanSearch,
          loadBatches: (_, {required caseId}) async => const [],
          scanCode: () async => 'CATH-DX-5F',
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumables-add-42')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumable-scan')));
    await tester.pumpAndSettle();

    expect(scannedQuery, 'CATH-DX-5F');
    expect(scannedCaseId, 42);
    expect(
      find.byKey(const ValueKey('cath-consumable-selected-item')),
      findsOneWidget,
    );
    expect(find.text('Diagnostic catheter'), findsOneWidget);
  });

  testWidgets('reused mode sends reused_device_tag and no batch fields', (
    tester,
  ) async {
    Map<String, dynamic>? sent;
    final deps = CathConsumableDependencies(
      loadConsumables: (_) async => const CathCaseConsumablesPayload(
        usage: [],
        restriction: CathReuseRestriction(
          status: 'clear',
          reasons: [],
          validityDays: 90,
        ),
        reprocessableCategories: {'catheter'},
      ),
      searchCatalog: ({required caseId, query, scan}) async => const [
        _untrackedItem,
      ],
      loadBatches: (_, {required caseId}) async => const [],
      lookupDevice: (_, tag) async => CathDeviceLookup(
        device: CathReprocessableDevice(
          id: 9,
          deviceTag: tag,
          itemName: 'Diagnostic catheter',
          category: 'catheter',
          status: 'available',
          cycleCount: 1,
          maxCycles: 3,
          exposureFlag: false,
          exposureMarkers: const [],
        ),
        reprocessable: true,
        cyclesRemaining: 2,
        requiresAcknowledgement: false,
        blocked: false,
      ),
      createUsage: (caseId, draft, {required idempotencyKey}) async {
        sent = draft.toJson();
        return CathCaseConsumableUsage.fromJson({
          'id': 77,
          'case_id': caseId,
          'catalog_item_id': 10,
          'item_name': 'Diagnostic catheter',
          'quantity': 1,
          'reuse_cycle': 1,
          'device_tag': 'RP00000042',
        });
      },
      scanCode: () async => null,
    );

    await tester.pumpWidget(_wrap(deps));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumables-add-42')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('cath-consumable-search')),
      'cath',
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumable-option-10')));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Reprocessed device'));
    await tester.pumpAndSettle();
    // Lower-case in, canonical upper-case out: the tag the operator typed is
    // normalised before it reaches either the lookup or the draft.
    await tester.enterText(
      find.byKey(const ValueKey('cath-consumable-device-tag')),
      'rp00000042',
    );
    await tester.tap(
      find.byKey(const ValueKey('cath-consumable-device-check')),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('cath-consumable-device-card')),
      findsOneWidget,
    );
    // Cycle 1 of a 3-cycle device reads as "2 of 4": cycle 0 is the first use.
    expect(find.textContaining('Cycle 2 of 4'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('cath-consumable-quantity')),
      findsNothing,
    );

    final save = find.byKey(const ValueKey('cath-consumable-save'));
    await tester.ensureVisible(save);
    await tester.tap(save);
    await tester.pumpAndSettle();

    expect(sent!['reused_device_tag'], 'RP00000042');
    expect(sent!.containsKey('batch_number'), isFalse);
    expect(sent!.containsKey('inventory_batch_id'), isFalse);
    expect(sent!.containsKey('exposure_acknowledgement'), isFalse);
    expect(sent!['quantity'], 1.0);
  });

  testWidgets(
    'restricted patient shows the strip and only the discard action',
    (tester) async {
      final deps = CathConsumableDependencies(
        loadConsumables: (_) async => CathCaseConsumablesPayload(
          usage: [
            CathCaseConsumableUsage.fromJson({
              'id': 5,
              'case_id': 42,
              'catalog_item_id': 10,
              'item_name': 'Diagnostic catheter',
              'quantity': 1,
              'allowed_post_use': {
                'dispositions': ['discard'],
                'requires_acknowledgement': false,
                'exposure': false,
                'discard_reason': 'bloodborne_exposure',
                'reason_codes': ['bloodborne_restricted'],
                'units_max': 1,
              },
            }),
          ],
          restriction: const CathReuseRestriction(
            status: 'restricted',
            reasons: ['HBsAg reactive 2026-08-12'],
            validityDays: 90,
          ),
          reprocessableCategories: const {'catheter'},
        ),
        scanCode: () async => null,
      );

      await tester.pumpWidget(_wrap(deps));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('cath-reuse-restriction-42')),
        findsOneWidget,
      );
      expect(find.text('HBsAg reactive 2026-08-12'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('cath-post-use-discard-5')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('cath-post-use-reprocess-5')),
        findsNothing,
      );
    },
  );

  testWidgets(
    'unknown serology: send to CSSD requires an acknowledgement and posts it',
    (tester) async {
      CathPostUseDraft? posted;
      final deps = CathConsumableDependencies(
        loadConsumables: (_) async => CathCaseConsumablesPayload(
          usage: [
            CathCaseConsumableUsage.fromJson({
              'id': 6,
              'case_id': 42,
              'catalog_item_id': 10,
              'item_name': 'Diagnostic catheter',
              'quantity': 2,
              'allowed_post_use': {
                'dispositions': ['reprocess', 'discard'],
                'requires_acknowledgement': true,
                'exposure': false,
                'reason_codes': ['serology_unknown'],
                'units_max': 2,
              },
            }),
          ],
          restriction: const CathReuseRestriction(
            status: 'unknown',
            reasons: ['HCV not on record'],
            validityDays: 90,
          ),
          reprocessableCategories: const {'catheter'},
        ),
        recordPostUse:
            (caseId, usageId, draft, {required idempotencyKey}) async {
              posted = draft;
              return const CathPostUseResult(
                usageId: 6,
                disposition: 'sent_for_reprocessing',
                deviceTags: ['RP00000001', 'RP00000002'],
              );
            },
        scanCode: () async => null,
      );

      await tester.pumpWidget(_wrap(deps));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cath-post-use-reprocess-6')));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('cath-post-use-confirm')));
      await tester.pumpAndSettle();
      expect(
        posted,
        isNull,
        reason: 'an empty acknowledgement must not submit',
      );

      await tester.enterText(
        find.byKey(const ValueKey('cath-post-use-acknowledgement')),
        'Emergency PCI, serology pending',
      );
      await tester.tap(find.byKey(const ValueKey('cath-post-use-confirm')));
      await tester.pumpAndSettle();

      expect(posted!.disposition, 'reprocess');
      expect(posted!.units, 2);
      expect(posted!.acknowledgementReason, 'Emergency PCI, serology pending');
    },
  );

  testWidgets(
    'a tag edited after the check cannot be saved as the old device',
    (tester) async {
      Map<String, dynamic>? sent;
      final deps = CathConsumableDependencies(
        loadConsumables: (_) async => const CathCaseConsumablesPayload(
          usage: [],
          restriction: CathReuseRestriction(
            status: 'clear',
            reasons: [],
            validityDays: 90,
          ),
          reprocessableCategories: {'catheter'},
        ),
        searchCatalog: ({required caseId, query, scan}) async => const [
          _untrackedItem,
        ],
        loadBatches: (_, {required caseId}) async => const [],
        lookupDevice: (_, tag) async => CathDeviceLookup(
          device: CathReprocessableDevice(
            id: 9,
            deviceTag: tag,
            itemName: 'Diagnostic catheter',
            category: 'catheter',
            status: 'available',
            cycleCount: 1,
            maxCycles: 3,
            exposureFlag: false,
            exposureMarkers: const [],
          ),
          reprocessable: true,
          cyclesRemaining: 2,
          requiresAcknowledgement: false,
          blocked: false,
        ),
        createUsage: (caseId, draft, {required idempotencyKey}) async {
          sent = draft.toJson();
          return CathCaseConsumableUsage.fromJson({
            'id': 78,
            'case_id': caseId,
            'catalog_item_id': 10,
            'item_name': 'Diagnostic catheter',
            'quantity': 1,
          });
        },
        scanCode: () async => null,
      );

      await tester.pumpWidget(_wrap(deps));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cath-consumables-add-42')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('cath-consumable-search')),
        'cath',
      );
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cath-consumable-option-10')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Reprocessed device'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const ValueKey('cath-consumable-device-tag')),
        'RP00000042',
      );
      await tester.tap(
        find.byKey(const ValueKey('cath-consumable-device-check')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('cath-consumable-device-card')),
        findsOneWidget,
      );
      // The card states the tag it was checked for, so a stale one is visible
      // rather than being inferred from the field above it.
      expect(find.textContaining('Tag RP00000042'), findsOneWidget);

      // Retyping the tag retires the checked device: the card describes a
      // device this save would no longer send.
      await tester.enterText(
        find.byKey(const ValueKey('cath-consumable-device-tag')),
        'RP00000099',
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('cath-consumable-device-card')),
        findsNothing,
      );

      final save = find.byKey(const ValueKey('cath-consumable-save'));
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pumpAndSettle();
      expect(
        sent,
        isNull,
        reason: 'an unchecked tag must not be saved as the checked device',
      );
      expect(
        find.byKey(const ValueKey('cath-consumable-error')),
        findsOneWidget,
      );

      // Re-checking is what makes the edited tag sendable, and it is the NEW
      // tag that goes out.
      await tester.tap(
        find.byKey(const ValueKey('cath-consumable-device-check')),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pumpAndSettle();
      expect(sent!['reused_device_tag'], 'RP00000099');
    },
  );

  testWidgets('a late device lookup cannot repopulate a retired tag', (
    tester,
  ) async {
    final release = Completer<CathDeviceLookup>();
    final deps = CathConsumableDependencies(
      loadConsumables: (_) async => const CathCaseConsumablesPayload(
        usage: [],
        restriction: CathReuseRestriction(
          status: 'clear',
          reasons: [],
          validityDays: 90,
        ),
        reprocessableCategories: {'catheter'},
      ),
      searchCatalog: ({required caseId, query, scan}) async => const [
        _untrackedItem,
      ],
      loadBatches: (_, {required caseId}) async => const [],
      lookupDevice: (_, _) => release.future,
      scanCode: () async => null,
    );

    await tester.pumpWidget(_wrap(deps));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumables-add-42')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('cath-consumable-search')),
      'cath',
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumable-option-10')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reprocessed device'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('cath-consumable-device-tag')),
      'RP00000042',
    );
    await tester.tap(
      find.byKey(const ValueKey('cath-consumable-device-check')),
    );
    await tester.pump();

    // The operator moves on before the lookup answers.
    await tester.tap(find.text('New unit'));
    await tester.pumpAndSettle();

    release.complete(
      const CathDeviceLookup(
        device: CathReprocessableDevice(
          id: 9,
          deviceTag: 'RP00000042',
          itemName: 'Diagnostic catheter',
          category: 'catheter',
          status: 'available',
          cycleCount: 1,
          maxCycles: 3,
          exposureFlag: false,
          exposureMarkers: [],
        ),
        reprocessable: true,
        cyclesRemaining: 2,
        requiresAcknowledgement: false,
        blocked: false,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Reprocessed device'));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('cath-consumable-device-card')),
      findsNothing,
    );
  });

  testWidgets('a failed post-use retry replays the same idempotency key', (
    tester,
  ) async {
    final keys = <String>[];
    var loads = 0;
    var attempts = 0;
    final deps = CathConsumableDependencies(
      loadConsumables: (_) async {
        loads += 1;
        return CathCaseConsumablesPayload(
          usage: [
            CathCaseConsumableUsage.fromJson({
              'id': 21,
              'case_id': 42,
              'catalog_item_id': 10,
              'item_name': 'Diagnostic catheter',
              'quantity': 2,
              'allowed_post_use': {
                'dispositions': ['reprocess'],
                'requires_acknowledgement': false,
                'exposure': false,
                'reason_codes': <String>[],
                'units_max': 2,
              },
            }),
          ],
          restriction: const CathReuseRestriction(
            status: 'clear',
            reasons: [],
            validityDays: 90,
          ),
          reprocessableCategories: const {'catheter'},
        );
      },
      recordPostUse: (caseId, usageId, draft, {required idempotencyKey}) async {
        keys.add(idempotencyKey);
        attempts += 1;
        // A first call that throws may still have been applied server-side.
        if (attempts == 1) throw Exception('synthetic transport failure');
        return const CathPostUseResult(
          usageId: 21,
          disposition: 'sent_for_reprocessing',
          deviceTags: ['RP00000021'],
        );
      },
      scanCode: () async => null,
    );

    await tester.pumpWidget(_wrap(deps));
    await tester.pumpAndSettle();
    final loadsBeforeFailure = loads;

    await tester.tap(find.byKey(const ValueKey('cath-post-use-reprocess-21')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-post-use-confirm')));
    await tester.pumpAndSettle();
    expect(find.textContaining('synthetic transport failure'), findsOneWidget);
    // The write may have landed before it failed, so the buttons on screen
    // are no longer trustworthy: the panel re-reads them.
    expect(loads, greaterThan(loadsBeforeFailure));

    await tester.tap(find.byKey(const ValueKey('cath-post-use-reprocess-21')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-post-use-confirm')));
    await tester.pumpAndSettle();

    expect(keys, hasLength(2));
    expect(
      keys.first,
      keys.last,
      reason: 'a retry must replay, not mint a second batch of CSSD devices',
    );
    expect(keys.first, startsWith('cath-post-use-21:'));
  });

  testWidgets('a device CSSD already discarded is reported as such', (
    tester,
  ) async {
    final deps = CathConsumableDependencies(
      loadConsumables: (_) async => CathCaseConsumablesPayload(
        usage: [
          CathCaseConsumableUsage.fromJson({
            'id': 22,
            'case_id': 42,
            'catalog_item_id': 10,
            'item_name': 'Diagnostic catheter',
            'quantity': 1,
            'allowed_post_use': {
              'dispositions': ['reprocess'],
              'requires_acknowledgement': false,
              'exposure': false,
              'reason_codes': <String>[],
              'units_max': 1,
            },
          }),
        ],
        restriction: const CathReuseRestriction(
          status: 'clear',
          reasons: [],
          validityDays: 90,
        ),
        reprocessableCategories: const {'catheter'},
      ),
      recordPostUse:
          (caseId, usageId, draft, {required idempotencyKey}) async =>
              const CathPostUseResult(
                usageId: 22,
                disposition: 'discarded',
                deviceTags: ['RP00000022'],
                deviceAlreadyDiscarded: true,
              ),
      scanCode: () async => null,
    );

    await tester.pumpWidget(_wrap(deps));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-post-use-reprocess-22')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-post-use-confirm')));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('CSSD has already marked this device as discarded'),
      findsOneWidget,
    );
    expect(find.textContaining('Post-use recorded'), findsNothing);
  });

  testWidgets('discard needs no acknowledgement even when reprocess would', (
    tester,
  ) async {
    CathPostUseDraft? posted;
    final deps = CathConsumableDependencies(
      loadConsumables: (_) async => CathCaseConsumablesPayload(
        usage: [
          CathCaseConsumableUsage.fromJson({
            'id': 23,
            'case_id': 42,
            'catalog_item_id': 10,
            'item_name': 'Diagnostic catheter',
            'quantity': 2,
            'allowed_post_use': {
              'dispositions': ['reprocess', 'discard'],
              'requires_acknowledgement': true,
              'exposure': false,
              'reason_codes': ['serology_unknown'],
              'units_max': 2,
            },
          }),
        ],
        restriction: const CathReuseRestriction(
          status: 'unknown',
          reasons: ['HCV not on record'],
          validityDays: 90,
        ),
        reprocessableCategories: const {'catheter'},
      ),
      recordPostUse: (caseId, usageId, draft, {required idempotencyKey}) async {
        posted = draft;
        return const CathPostUseResult(
          usageId: 23,
          disposition: 'discarded',
          deviceTags: [],
        );
      },
      scanCode: () async => null,
    );

    await tester.pumpWidget(_wrap(deps));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-post-use-discard-23')));
    await tester.pumpAndSettle();

    // Taking a device OUT of service must never be gated behind an
    // attestation about putting it back into service.
    expect(
      find.byKey(const ValueKey('cath-post-use-acknowledgement')),
      findsNothing,
    );
    // The note rides the discard, so it is labelled as a note, not as the
    // wastage reason of an opened-but-unused unit.
    expect(find.text('Note'), findsOneWidget);
    expect(find.text('Wastage reason'), findsNothing);
    expect(find.text('Confirm'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('cath-post-use-confirm')));
    await tester.pumpAndSettle();

    expect(posted, isNotNull);
    expect(posted!.disposition, 'discard');
    expect(posted!.acknowledgementReason, isNull);
    expect(posted!.units, isNull);
  });

  for (final probe in const <List<String>>[
    ['restricted', 'visible'],
    ['unknown', 'visible'],
    ['clear', 'absent'],
  ]) {
    testWidgets(
      'the restriction strip is ${probe.last} for ${probe.first} serology',
      (tester) async {
        final deps = CathConsumableDependencies(
          loadConsumables: (_) async => CathCaseConsumablesPayload(
            usage: const [],
            restriction: CathReuseRestriction(
              status: probe.first,
              reasons: const ['HCV not on record'],
              validityDays: 90,
            ),
            reprocessableCategories: const {'catheter'},
          ),
          scanCode: () async => null,
        );

        await tester.pumpWidget(_wrap(deps));
        await tester.pumpAndSettle();

        expect(
          find.byKey(const ValueKey('cath-reuse-restriction-42')),
          probe.last == 'visible' ? findsOneWidget : findsNothing,
        );
      },
    );
  }

  testWidgets('the strip refuses to render a clear case and caps its reasons', (
    tester,
  ) async {
    Widget host(CathReuseRestriction restriction) => MaterialApp(
      home: Scaffold(body: CathReuseRestrictionStrip(restriction: restriction)),
    );

    // The guard lives in the strip, so no caller can render an empty amber
    // box for a patient with nothing to warn about.
    await tester.pumpWidget(
      host(
        const CathReuseRestriction(
          status: 'clear',
          reasons: ['ignored'],
          validityDays: 90,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('ignored'), findsNothing);

    await tester.pumpWidget(
      host(
        const CathReuseRestriction(
          status: 'restricted',
          reasons: [
            'HBsAg reactive',
            'HCV reactive',
            'HIV reactive',
            'Syphilis reactive',
            'HTLV reactive',
            'Malaria reactive',
          ],
          validityDays: 90,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('HBsAg reactive'), findsOneWidget);
    expect(find.text('Syphilis reactive'), findsOneWidget);
    expect(find.text('HTLV reactive'), findsNothing);
    expect(find.text('+2 more'), findsOneWidget);
  });
}
