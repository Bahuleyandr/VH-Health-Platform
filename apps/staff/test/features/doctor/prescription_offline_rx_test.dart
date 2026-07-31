import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/doctor/prescription_offline_rx.dart';

void main() {
  test('offline prescription work routes only to a private local draft', () {
    expect(
      prescriptionSubmissionDisposition(isOnline: false),
      PrescriptionSubmissionDisposition.attemptLocalDraft,
    );
  });

  test('online prescription creation retains the server submission path', () {
    expect(
      prescriptionSubmissionDisposition(isOnline: true),
      PrescriptionSubmissionDisposition.submitOnline,
    );
  });

  test('the disposition API exposes no contained enqueue path', () {
    expect(
      PrescriptionSubmissionDisposition.values.map((value) => value.name),
      isNot(contains('enqueue')),
    );
  });
}
