// lib/features/ipd/drug_chart_offline_order.dart
//
// Pure routing decision for inpatient drug-chart order submission. Offline
// creation is contained in C0A and therefore has no enqueue disposition.

enum DrugChartSubmissionDisposition { submitOnline, usePaperFallback }

DrugChartSubmissionDisposition drugChartSubmissionDisposition({
  required bool isOnline,
}) => isOnline
    ? DrugChartSubmissionDisposition.submitOnline
    : DrugChartSubmissionDisposition.usePaperFallback;
