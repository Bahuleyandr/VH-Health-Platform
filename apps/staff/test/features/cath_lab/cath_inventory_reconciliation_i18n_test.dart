import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/cath_lab/screens/cath_inventory_reconciliation_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  const keys = <String>[
    'med03.cath_inventory.title',
    'med03.cath_inventory.access_denied',
    'med03.cath_inventory.invalid_target',
    'med03.cath_inventory.target_mismatch',
    'med03.cath_inventory.load_failed',
    'med03.cath_inventory.summary',
    'med03.cath_inventory.case_id',
    'med03.cath_inventory.usage_id',
    'med03.cath_inventory.patient_uid',
    'med03.cath_inventory.item',
    'med03.cath_inventory.inventory_item_id',
    'med03.cath_inventory.inventory_batch_id',
    'med03.cath_inventory.batch_number',
    'med03.cath_inventory.documented_quantity',
    'med03.cath_inventory.decremented_quantity',
    'med03.cath_inventory.remaining_quantity',
    'med03.cath_inventory.status',
    'med03.cath_inventory.task_status',
    'med03.cath_inventory.sla_status',
    'med03.cath_inventory.due_at',
    'med03.cath_inventory.value_unknown',
    'med03.cath_inventory.status.insufficient_stock',
    'med03.cath_inventory.status.decremented',
    'med03.cath_inventory.status.unknown',
    'med03.cath_inventory.task_status.open',
    'med03.cath_inventory.task_status.in_progress',
    'med03.cath_inventory.task_status.overdue',
    'med03.cath_inventory.task_status.completed',
    'med03.cath_inventory.task_status.unknown',
    'med03.cath_inventory.sla_status.active',
    'med03.cath_inventory.sla_status.breached',
    'med03.cath_inventory.sla_status.escalated',
    'med03.cath_inventory.sla_status.completed',
    'med03.cath_inventory.sla_status.cancelled',
    'med03.cath_inventory.sla_status.unknown',
    'med03.cath_inventory.not_actionable',
    'med03.cath_inventory.coverage_only',
    'med03.cath_inventory.confirm_title',
    'med03.cath_inventory.confirm_body',
    'med03.cath_inventory.confirm_action',
    'med03.cath_inventory.reconcile_action',
    'med03.cath_inventory.retry_same_attempt',
    'med03.cath_inventory.reconciling',
    'med03.cath_inventory.completed',
    'med03.cath_inventory.still_insufficient',
    'med03.cath_inventory.response_unconfirmed',
    'med03.cath_inventory.refresh_action',
    'med03.cath_inventory.warning.insufficient_stock',
    'med03.cath_inventory.warning.batch_expired',
    'med03.cath_inventory.warning.quantity_invalid',
    'med03.cath_inventory.warning.lineage_mismatch',
    'med03.cath_inventory.warning.lineage_incomplete',
    'med03.cath_inventory.warning.controlled_stock',
    'med03.cath_inventory.warning.inventory_not_linked',
    'med03.cath_inventory.warning.batch_unavailable',
    'med03.cath_inventory.warning.unknown',
  ];

  test('Cath inventory workflow ships in all five staff locales', () {
    final english = AppStrings.forLocale(const Locale('en'));
    for (final locale in const ['hi', 'ta', 'te', 'ml']) {
      final localized = AppStrings.forLocale(Locale(locale));
      for (final key in keys) {
        expect(localized.lookup(key), isNot(key), reason: '$locale $key');
        expect(
          localized.lookup(key),
          isNot(english.lookup(key)),
          reason: '$locale must not fall back to English for $key',
        );
      }
    }
  });

  test('inventory, task, and SLA enums are always localized', () {
    final strings = AppStrings.forLocale(const Locale('en'));
    for (final code in const ['insufficient_stock', 'decremented']) {
      expect(
        localizedCathInventoryStatus(strings, code),
        strings.lookup('med03.cath_inventory.status.$code'),
      );
    }
    for (final code in const ['open', 'in_progress', 'overdue', 'completed']) {
      expect(
        localizedCathInventoryTaskStatus(strings, code),
        strings.lookup('med03.cath_inventory.task_status.$code'),
      );
    }
    for (final code in const [
      'active',
      'breached',
      'escalated',
      'completed',
      'cancelled',
    ]) {
      expect(
        localizedCathInventorySlaStatus(strings, code),
        strings.lookup('med03.cath_inventory.sla_status.$code'),
      );
    }
    expect(
      localizedCathInventoryStatus(strings, 'raw_backend_status'),
      strings.lookup('med03.cath_inventory.status.unknown'),
    );
  });

  test('inventory warning text is bounded to localized stable categories', () {
    final strings = AppStrings.forLocale(const Locale('en'));
    final examples = <String, String>{
      'Insufficient stock: documented 2, decremented 1': 'insufficient_stock',
      'Exact inventory batch is expired; clinical usage was saved without a stock decrement':
          'batch_expired',
      'Exact inventory batch quantity is invalid; clinical usage was saved without a stock decrement':
          'quantity_invalid',
      'Documented batch/lot/expiry does not match the selected inventory batch; clinical usage was saved without a stock decrement':
          'lineage_mismatch',
      'Documented inventory lineage is incomplete; clinical usage was saved without a stock decrement':
          'lineage_incomplete',
      'Controlled stock requires the statutory dispensing workflow; no Cath inventory movement was recorded':
          'controlled_stock',
      'Catalog item is not linked to inventory; clinical usage was saved without a stock decrement':
          'inventory_not_linked',
      'Exact inventory batch is quarantined; clinical usage was saved without a stock decrement':
          'batch_unavailable',
    };
    for (final entry in examples.entries) {
      expect(
        localizedCathInventoryWarning(strings, entry.key),
        strings.lookup('med03.cath_inventory.warning.${entry.value}'),
      );
    }
    expect(
      localizedCathInventoryWarning(strings, 'raw backend warning'),
      strings.lookup('med03.cath_inventory.warning.unknown'),
    );
  });
}
