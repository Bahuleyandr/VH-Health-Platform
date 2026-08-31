import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/navigation/app_router.dart';
import 'package:vhhealth_staff/features/pharmacy/screens/counter_sale_screen.dart';
import 'package:vhhealth_staff/features/pharmacy/screens/pharmacy_screen.dart';

void main() {
  test('targeted pharmacy route selects the exact counter sale', () {
    final screen = buildPharmacyScreenForRoute(
      Uri.parse('/pharmacy?tab=counter-sales&sale_id=9223372036854775806'),
    );

    expect(screen, isA<CounterSaleScreen>());
    expect((screen as CounterSaleScreen).initialSaleId, '9223372036854775806');
  });

  test('ward-indent and malformed counter-sale queries do not cross-wire', () {
    final ward = buildPharmacyScreenForRoute(
      Uri.parse('/pharmacy?tab=ward-indents&indent_id=73'),
    );
    final malformed = buildPharmacyScreenForRoute(
      Uri.parse('/pharmacy?tab=counter-sales&sale_id=0'),
    );

    expect(ward, isA<PharmacyScreen>());
    expect((ward as PharmacyScreen).initialIndentId, 73);
    expect(malformed, isA<PharmacyScreen>());
  });

  test('ward-indent routes reject PostgreSQL int4 overflow identifiers', () {
    final maximum = buildPharmacyScreenForRoute(
      Uri.parse('/pharmacy?tab=ward-indents&indent_id=2147483647'),
    );
    final overflow = buildPharmacyScreenForRoute(
      Uri.parse('/pharmacy?tab=ward-indents&indent_id=2147483648'),
    );

    expect((maximum as PharmacyScreen).initialIndentId, 2147483647);
    expect((overflow as PharmacyScreen).initialIndentId, isNull);
  });

  test('targeted finance route preserves both exact identifiers', () {
    final screen = buildCounterSaleRefundScreenForRoute(
      Uri.parse(
        '/billing/refunds?refund_id=7&void_request_id=9223372036854775806',
      ),
    );

    expect(screen.refundId, '7');
    expect(screen.voidRequestId, '9223372036854775806');
  });

  test(
    'generic finance route preserves an exact refund without a void request',
    () {
      final screen = buildCounterSaleRefundScreenForRoute(
        Uri.parse('/billing/refunds?refund_id=7'),
      );

      expect(screen.refundId, '7');
      expect(screen.voidRequestId, isEmpty);
    },
  );
}
