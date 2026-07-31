// lib/features/doctor/prescription_offline_rx.dart
//
// Pure routing decision for prescription submission. Offline prescription
// work may enter only the encrypted local-draft gate; it is never enqueued.

enum PrescriptionSubmissionDisposition { submitOnline, attemptLocalDraft }

PrescriptionSubmissionDisposition prescriptionSubmissionDisposition({
  required bool isOnline,
}) => isOnline
    ? PrescriptionSubmissionDisposition.submitOnline
    : PrescriptionSubmissionDisposition.attemptLocalDraft;
