import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/navigation/app_router.dart';

void main() {
  test('orders route carries the governed ICU MAR review admission id', () {
    const uid = '11111111-1111-4111-8111-111111111111';
    final screen = buildOrdersScreenForRoute(
      patientUid: uid,
      uri: Uri.parse('/emr/orders/$uid?icu_mar_review=81'),
    );

    expect(screen.patientUid, uid);
    expect(screen.icuMarReviewAdmissionId, 81);
    expect(screen.marRecoveryOrderId, isNull);
  });

  test('orders route keeps medication-order recovery distinct', () {
    const uid = '11111111-1111-4111-8111-111111111111';
    final screen = buildOrdersScreenForRoute(
      patientUid: uid,
      uri: Uri.parse('/emr/orders/$uid?mar_recovery_order=73'),
    );

    expect(screen.marRecoveryOrderId, 73);
    expect(screen.icuMarReviewAdmissionId, isNull);
  });
}
