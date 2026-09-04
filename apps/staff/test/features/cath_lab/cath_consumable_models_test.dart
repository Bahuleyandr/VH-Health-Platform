import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/cath_lab/models/cath_consumable_models.dart';

void main() {
  test('catalog and batch models parse defensive backend wire values', () {
    final item = CathConsumableCatalogItem.fromJson({
      'id': '17',
      'item_name': 'Drug-eluting stent',
      'category': 'stent',
      'manufacturer': 'Synthetic Medical',
      'model': 'DES-30',
      'is_implant': true,
      'batch_tracked': 'true',
      'inventory_item_id': '91',
      'inventory_sku': 'CATH-DES-30',
      'inventory_unit_label': 'unit',
      'status': 'active',
    });
    final batch = CathInventoryBatch.fromJson({
      'id': 44,
      'inventory_item_id': '91',
      'batch_number': 'B-2026-07',
      'lot_number': 'LOT-7',
      'expiry_date': '2028-06-30',
      'remaining_quantity': '4.5000',
      'status': 'in_stock',
    });

    expect(item.id, 17);
    expect(item.isImplant, isTrue);
    expect(item.batchTracked, isTrue);
    expect(item.skuCode, 'CATH-DES-30');
    expect(item.unitLabel, 'unit');
    expect(batch.remainingQuantity, 4.5);
    expect(batch.expiryDate, isNotNull);
  });

  test(
    'usage preserves inventory warning and draft emits conditional fields',
    () {
      final usage = CathCaseConsumableUsage.fromJson({
        'id': '71',
        'case_id': 42,
        'catalog_item_id': 17,
        'item_name': 'Drug-eluting stent',
        'category': 'stent',
        'inventory_unit_label': 'unit',
        'quantity': '2.0000',
        'batch_number': 'B-2026-07',
        'expiry_date': '2028-06-30',
        'serial_number': 'SER-1001',
        'wasted': false,
        'is_implant': true,
        'batch_tracked': true,
        'inventory_warning': 'Insufficient stock; documentation retained',
        'inventory_decrement_status': 'warning',
        'used_by_name': 'Dr Test',
        'used_at': '2026-07-11T08:30:00.000Z',
        'recorded_at': '2026-07-11T09:30:00.000Z',
      });
      final draft = CathConsumableUsageDraft(
        catalogItemId: 17,
        quantity: 2,
        procedureLogId: 71,
        inventoryBatchId: 44,
        batchNumber: 'B-2026-07',
        expiryDate: DateTime(2028, 6, 30),
        serialNumber: 'SER-1001',
        wasted: true,
        wastageReason: 'Opened but deployment aborted',
      );

      expect(usage.hasInventoryWarning, isTrue);
      expect(usage.quantity, 2);
      expect(usage.unitLabel, 'unit');
      expect(usage.usedByName, 'Dr Test');
      expect(
        usage.recordedAt?.toUtc(),
        DateTime.parse('2026-07-11T08:30:00.000Z'),
      );
      expect(draft.toJson(), {
        'catalog_item_id': '17',
        'quantity': 2.0,
        'procedure_log_id': '71',
        'inventory_batch_id': 44,
        'batch_number': 'B-2026-07',
        'expiry_date': '2028-06-30',
        'serial_number': 'SER-1001',
        'wasted': true,
        'waste_reason': 'Opened but deployment aborted',
      });
    },
  );

  test('draft emits reused_device_tag and exposure acknowledgement, no batch fields', () {
    const draft = CathConsumableUsageDraft(
      catalogItemId: 10,
      quantity: 1,
      wasted: false,
      reusedDeviceTag: 'RP00000042',
      exposureAcknowledgementReason: 'reviewed',
    );

    expect(draft.toJson(), {
      'catalog_item_id': '10',
      'quantity': 1.0,
      'wasted': false,
      'reused_device_tag': 'RP00000042',
      'exposure_acknowledgement': {'reason': 'reviewed'},
    });
  });

  test('usage parses reuse fields and post-use options', () {
    final usage = CathCaseConsumableUsage.fromJson({
      'id': 5,
      'case_id': 42,
      'catalog_item_id': 10,
      'item_name': 'Diagnostic catheter',
      'quantity': '1.0000',
      'device_tag': 'RP00000042',
      'reuse_cycle': 2,
      'inventory_decrement_status': 'reused_device',
      'allowed_post_use': {
        'dispositions': ['discard'],
        'requires_acknowledgement': false,
        'exposure': false,
        'discard_reason': 'max_cycles_reached',
        'reason_codes': ['max_cycles_reached'],
        'units_max': 1,
      },
    });

    expect(usage.isReused, isTrue);
    expect(usage.deviceTag, 'RP00000042');
    expect(usage.allowedPostUse!.canReprocess, isFalse);
    expect(usage.allowedPostUse!.canDiscard, isTrue);
    expect(usage.allowedPostUse!.discardReason, 'max_cycles_reached');
  });

  test('a first-use row is not reused and carries no post-use options', () {
    final usage = CathCaseConsumableUsage.fromJson({
      'id': 6,
      'case_id': 42,
      'catalog_item_id': 10,
      'item_name': 'Diagnostic catheter',
      'quantity': 1,
      'reuse_cycle': 0,
    });

    expect(usage.isReused, isFalse);
    expect(usage.allowedPostUse, isNull);
    expect(usage.deviceTag, isEmpty);
  });

  test('restriction tolerates the redacted payload non-clinical roles get', () {
    final restriction = CathReuseRestriction.fromJson({
      'status': 'restricted',
      'reasons': <Object?>[],
      'markers': <Object?>[],
      'validity_days': 120,
    });

    expect(restriction.isRestricted, isTrue);
    expect(restriction.reasons, isEmpty);
    expect(restriction.validityDays, 120);
    // An absent status must not read as "clear" — the strip has to render.
    expect(CathReuseRestriction.fromJson(const {}).isUnknown, isTrue);
  });

  test(
    'device lookup is only usable when available, reprocessable, unblocked',
    () {
      final lookup = CathDeviceLookup.fromJson({
        'device': {
          'id': '9',
          'device_tag': 'RP00000042',
          'item_name': 'Diagnostic catheter',
          'category': 'catheter',
          'status': 'available',
          'cycle_count': '1',
          'max_cycles_snapshot': '3',
          'exposure_flag': false,
          'exposure_markers': <Object?>[],
        },
        'reprocessable': true,
        'cycles_remaining': 2,
        'requires_acknowledgement': false,
        'blocked': false,
      });

      expect(lookup.usable, isTrue);
      expect(lookup.device.cycleCount, 1);
      expect(lookup.device.maxCycles, 3);

      final blocked = CathDeviceLookup.fromJson({
        'device': {'device_tag': 'RP00000043', 'status': 'available'},
        'reprocessable': true,
        'blocked': true,
      });
      expect(blocked.usable, isFalse);
    },
  );

  test('post-use draft and result map the wire shape', () {
    const draft = CathPostUseDraft(
      disposition: 'reprocess',
      units: 2,
      acknowledgementReason: 'Emergency PCI, serology pending',
    );

    expect(draft.toJson(), {
      'disposition': 'reprocess',
      'units': 2,
      'acknowledgement': {'reason': 'Emergency PCI, serology pending'},
    });

    final result = CathPostUseResult.fromJson({
      'usage_id': '6',
      'disposition': 'sent_for_reprocessing',
      'devices': [
        {'device_tag': 'RP00000001'},
        {'device_tag': 'RP00000002'},
      ],
      // Unknown keys the backend may add stay ignored.
      'device_already_discarded': true,
      'idempotent_replay': true,
    });

    expect(result.usageId, 6);
    expect(result.disposition, 'sent_for_reprocessing');
    expect(result.deviceTags, ['RP00000001', 'RP00000002']);
  });
}
