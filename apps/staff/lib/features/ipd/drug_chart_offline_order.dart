// lib/features/ipd/drug_chart_offline_order.dart
//
// Pure routing decision for inpatient drug-chart work. Offline work may enter
// only the encrypted local-draft gate; it is never an order or queue command.

enum DrugChartSubmissionDisposition { submitOnline, attemptLocalDraft }

DrugChartSubmissionDisposition drugChartSubmissionDisposition({
  required bool isOnline,
}) => isOnline
    ? DrugChartSubmissionDisposition.submitOnline
    : DrugChartSubmissionDisposition.attemptLocalDraft;
