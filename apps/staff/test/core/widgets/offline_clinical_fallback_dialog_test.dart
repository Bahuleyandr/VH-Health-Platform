import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/doctor/prescription_offline_rx.dart';
import 'package:vhhealth_staff/features/ipd/drug_chart_offline_order.dart';

void main() {
  test('offline prescription work does not select a paper fallback', () {
    expect(
      prescriptionSubmissionDisposition(isOnline: false),
      PrescriptionSubmissionDisposition.attemptLocalDraft,
    );
    expect(
      PrescriptionSubmissionDisposition.values.map((value) => value.name),
      isNot(contains('usePaperFallback')),
    );
  });

  test('offline drug-chart work does not select a paper fallback', () {
    expect(
      drugChartSubmissionDisposition(isOnline: false),
      DrugChartSubmissionDisposition.attemptLocalDraft,
    );
    expect(
      DrugChartSubmissionDisposition.values.map((value) => value.name),
      isNot(contains('usePaperFallback')),
    );
  });
}
