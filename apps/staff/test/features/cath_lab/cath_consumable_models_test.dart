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
}
