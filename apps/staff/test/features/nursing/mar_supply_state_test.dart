import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/nursing/screens/mar_scan_screen.dart';

void main() {
  test('exact custody is administrable without an override', () {
    const state = {'status': 'available'};
    expect(marSupplyIsHardBlocked(state), isFalse);
    expect(marSupplyRequiresQuantity(state), isFalse);
    expect(marSupplyRequiresOverrideReason(state), isFalse);
  });

  test('missing quantity requires structured input', () {
    const state = {'status': 'quantity_required'};
    expect(marSupplyIsHardBlocked(state), isFalse);
    expect(marSupplyRequiresQuantity(state), isTrue);
    expect(marSupplyRequiresOverrideReason(state), isFalse);
  });

  test('custody shortage requires a documented override', () {
    const state = {'status': 'custody_unavailable'};
    expect(marSupplyIsHardBlocked(state), isFalse);
    expect(marSupplyRequiresQuantity(state), isFalse);
    expect(marSupplyRequiresOverrideReason(state), isTrue);
  });

  test('ambiguous or unreconciled evidence remains a hard stop', () {
    for (final status in [
      'order_link_required',
      'ward_item_required',
      'ward_item_ambiguous',
      'reconciliation_required',
      'unknown',
    ]) {
      expect(
        marSupplyIsHardBlocked({'status': status}),
        isTrue,
        reason: status,
      );
    }
  });
}
