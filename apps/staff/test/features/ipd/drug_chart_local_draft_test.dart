import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/ipd/drug_chart_offline_order.dart';

void main() {
  test('offline inpatient order work enters only the local-draft decision', () {
    expect(
      drugChartSubmissionDisposition(isOnline: false),
      DrugChartSubmissionDisposition.attemptLocalDraft,
    );
    expect(
      DrugChartSubmissionDisposition.values.map((value) => value.name),
      isNot(contains('queueOffline')),
    );
  });
}
