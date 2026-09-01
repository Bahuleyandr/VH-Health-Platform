import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/navigation/app_router.dart';

void main() {
  test('targeted Cath inventory route preserves both exact identifiers', () {
    final screen = buildCathInventoryReconciliationScreenForRoute(
      Uri.parse(
        '/pharmacy/cath-inventory-reconciliation?case_id=7'
        '&consumable_usage_id=9223372036854775806',
      ),
    );

    expect(screen.caseId, '7');
    expect(screen.consumableUsageId, '9223372036854775806');
  });
}
