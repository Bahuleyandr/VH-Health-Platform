import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/doctor/prescription_offline_rx.dart';

void main() {
  test('offline prescription work enters only the local-draft decision', () {
    expect(
      prescriptionSubmissionDisposition(isOnline: false),
      PrescriptionSubmissionDisposition.attemptLocalDraft,
    );
    expect(
      PrescriptionSubmissionDisposition.values.map((value) => value.name),
      isNot(contains('queueOffline')),
    );
  });
}
