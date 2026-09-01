import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/reception/screens/gateway_refund_reconciliation_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

Map<String, dynamic> _row() => {
  'id': 31,
  'provider': 'dry_run',
  'billing_refund_id': 7,
  'provider_payment_id': 'pay_dry_7',
  'provider_refund_id': 'rfnd_dry_7',
  'amount': 150.0,
  'currency': 'INR',
  'status': 'requires_reconciliation',
  'failure_code': 'billing_refund_finalize_failed',
  'failure_reason': 'Provider succeeded but billing finalization failed',
};

Future<void> _pump(
  WidgetTester tester, {
  required String role,
  required Future<List<Map<String, dynamic>>> Function() listRefunds,
}) async {
  tester.view.physicalSize = const Size(1400, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ChangeNotifierProvider<ThemeProvider>(
      create: (_) => ThemeProvider(),
      child: MaterialApp(
        home: GatewayRefundReconciliationScreen(
          roleLoader: () async => role,
          listRefunds: listRefunds,
          resolveRefund: ({
            required gatewayRefundId,
            required disposition,
            required evidenceReference,
            required note,
          }) async => {'id': gatewayRefundId},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  test('role and authority-route contracts stay fail closed', () {
    expect(gatewayRefundReconciliationCanOpen('ADMIN'), isTrue);
    expect(gatewayRefundReconciliationCanOpen('SUPER_ADMIN'), isTrue);
    expect(gatewayRefundReconciliationCanOpen('BILLING_INCHARGE'), isFalse);
    expect(gatewayRefundAuthorityRoute(7), '/billing/refunds?refund_id=7');
    expect(gatewayRefundAuthorityRoute('2147483647'), isNotNull);
    expect(gatewayRefundAuthorityRoute('2147483648'), isNull);
    expect(gatewayRefundAuthorityRoute('07'), isNull);
  });

  testWidgets('non-admin roles cannot load provider refund evidence', (
    tester,
  ) async {
    var calls = 0;
    await _pump(
      tester,
      role: 'BILLING_INCHARGE',
      listRefunds: () async {
        calls += 1;
        return [_row()];
      },
    );

    expect(calls, 0);
    expect(find.byType(TextField), findsNothing);
    expect(
      find.text('Platform administrator access is required.'),
      findsOneWidget,
    );
  });

  testWidgets('admin can discover and inspect every parked refund field', (
    tester,
  ) async {
    var calls = 0;
    await _pump(
      tester,
      role: 'ADMIN',
      listRefunds: () async {
        calls += 1;
        return [_row()];
      },
    );

    expect(calls, 1);
    expect(find.text('dry_run · #31'), findsOneWidget);
    await tester.tap(find.text('dry_run · #31'));
    await tester.pumpAndSettle();

    expect(find.text('Gateway refund #31'), findsOneWidget);
    expect(find.text('pay_dry_7'), findsOneWidget);
    expect(find.text('rfnd_dry_7'), findsOneWidget);
    expect(
      find.text('Provider succeeded but billing finalization failed'),
      findsOneWidget,
    );
    expect(find.byType(TextField), findsNWidgets(2));
    expect(find.text('Record verified outcome'), findsOneWidget);
  });

  test('new recovery copy has technical parity across five locales', () {
    for (final locale in const ['en', 'hi', 'ta', 'te', 'ml']) {
      final strings = AppStrings.forLocale(Locale(locale));
      for (final key in const [
        'med03.gateway_refund_reconciliation.title',
        'med03.gateway_refund_reconciliation.disposition.provider_not_refunded',
        'med03.gateway_refund_reconciliation.disposition.manual_settled',
        'med03.gateway_refund_reconciliation.validation',
        'med03.notification.gateway_refund_reconciliation.title',
        'med03.notification.gateway_refund_reconciliation.body',
        'med03.notification.gateway_refund_reconciliation.action',
      ]) {
        final value = strings.lookup(key);
        expect(value, isNotEmpty, reason: '$locale:$key');
        expect(value, isNot(key), reason: '$locale:$key');
      }
    }
  });
}
