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
      'batch_unavailable',
      'unknown',
    ]) {
      expect(
        marSupplyIsHardBlocked({'status': status}),
        isTrue,
        reason: status,
      );
    }
  });

  test('unknown and future supply statuses fail closed as unknown', () {
    for (final state in <Map<String, dynamic>?>[
      null,
      const {},
      const {'status': 'future_auto_allocate'},
      const {'status': ''},
    ]) {
      expect(marSupplyStatus(state), 'unknown', reason: '$state');
      expect(marSupplyIsHardBlocked(state), isTrue, reason: '$state');
      expect(marSupplyRequiresQuantity(state), isFalse, reason: '$state');
      expect(marSupplyRequiresOverrideReason(state), isFalse, reason: '$state');
    }
  });
}
