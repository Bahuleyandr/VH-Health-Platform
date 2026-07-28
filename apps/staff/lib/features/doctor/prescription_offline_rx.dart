// lib/features/doctor/prescription_offline_rx.dart
//
// Pure routing decision for prescription submission. Offline prescription
// creation is contained in C0A and therefore has no enqueue disposition.

enum PrescriptionSubmissionDisposition { submitOnline, usePaperFallback }

PrescriptionSubmissionDisposition prescriptionSubmissionDisposition({
  required bool isOnline,
}) => isOnline
    ? PrescriptionSubmissionDisposition.submitOnline
    : PrescriptionSubmissionDisposition.usePaperFallback;
