import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/reception/screens/billing_credit_notes_screen.dart';

void main() {
  test('refund workbench routes enforce the PostgreSQL integer boundary', () {
    expect(
      billingRefundWorkbenchRoute(2147483647),
      '/billing/refunds?refund_id=2147483647',
    );
    expect(billingRefundWorkbenchRoute(2147483648), isNull);
    expect(billingRefundWorkbenchRoute('01'), isNull);
  });

  test('credit-note review mirrors the backend reviewer roster', () {
    for (final role in const [
      'ADMIN',
      'SUPER_ADMIN',
      'FINANCE_INCHARGE',
      'BILLING_INCHARGE',
    ]) {
      expect(billingCreditNoteCanReview(role), isTrue, reason: role);
    }
    for (final role in const [
      'BILLING_STAFF',
      'RECEPTIONIST',
      'DOCTOR',
      'GENERAL_STAFF',
    ]) {
      expect(billingCreditNoteCanReview(role), isFalse, reason: role);
    }
  });

  test('refund approval is narrower than payout execution', () {
    expect(billingCreditNoteCanApproveRefund('ADMIN'), isTrue);
    expect(billingCreditNoteCanApproveRefund('SUPER_ADMIN'), isTrue);
    expect(billingCreditNoteCanApproveRefund('FINANCE_INCHARGE'), isFalse);
    expect(billingCreditNoteCanSettleRefund('FINANCE_INCHARGE'), isTrue);
    expect(billingCreditNoteCanSettleRefund('BILLING_INCHARGE'), isTrue);
    expect(billingCreditNoteCanSettleRefund('RECEPTIONIST'), isFalse);
  });

  test('manual and gateway modes never overlap', () {
    expect(
      manualMedicationRefundModes.intersection(gatewayMedicationRefundModes),
      isEmpty,
    );
    expect(manualMedicationRefundModes, containsAll(['CASH', 'CHEQUE', 'DD']));
    expect(
      gatewayMedicationRefundModes,
      containsAll(['CARD', 'UPI', 'NETBANKING', 'WALLET']),
    );
    expect(
      manualMedicationRefundModes.union(gatewayMedicationRefundModes),
      isNot(contains('INSURANCE')),
    );
  });

  test('approved medication refunds route to the generic exact workbench', () {
    expect(billingRefundWorkbenchRoute(7), '/billing/refunds?refund_id=7');
    for (final invalid in [
      null,
      '',
      0,
      -1,
      '07',
      'not-an-id',
      '9223372036854775807',
    ]) {
      expect(billingRefundWorkbenchRoute(invalid), isNull, reason: '$invalid');
    }
  });
}
