import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/ipd/drug_chart_offline_order.dart';

void main() {
  test('offline drug-chart work routes only to a private local draft', () {
    expect(
      drugChartSubmissionDisposition(isOnline: false),
      DrugChartSubmissionDisposition.attemptLocalDraft,
    );
  });

  test('online drug-chart orders retain the server submission path', () {
    expect(
      drugChartSubmissionDisposition(isOnline: true),
      DrugChartSubmissionDisposition.submitOnline,
    );
  });

  test('the disposition API exposes no contained enqueue path', () {
    expect(
      DrugChartSubmissionDisposition.values.map((value) => value.name),
      isNot(contains('enqueue')),
    );
  });
}
