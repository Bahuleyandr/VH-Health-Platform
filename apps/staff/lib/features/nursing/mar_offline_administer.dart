import 'package:vhhealth_core/services/mar_five_rights.dart';

/// Pure decision for the OFFLINE administer path — keeps the screen thin and the
/// safety branch unit-testable. INVARIANT: a patient/drug hard-stop NEVER enqueues.
class OfflineAdministerIntent {
  const OfflineAdministerIntent({
    required this.hardStop,
    required this.enqueue,
    required this.endpoint,
    required this.body,
    required this.rights,
  });
  final bool hardStop; // patient/drug mismatch → abort + re-scan
  final bool enqueue; // safe to queue the administer
  final String endpoint;
  final Map<String, dynamic> body;
  final FiveRights rights;
}

OfflineAdministerIntent buildOfflineAdministerIntent({
  required Map<String, dynamic> dose,
  required String scannedPatientUid,
  required String scannedBarcode,
  required DateTime at,
  String? overrideReason,
}) {
  final rights = evaluateFiveRights(
    dose: dose,
    scannedPatientUid: scannedPatientUid,
    scannedBarcode: scannedBarcode,
    at: at,
  );
  final hardStop = !rights.patient || !rights.drug;
  // Soft-fail without an override can't be auto-queued (the UI must collect a reason).
  final softBlocked = !rights.allPassed &&
      (overrideReason == null || overrideReason.trim().length < 5);
  final maId = dose['id'];
  return OfflineAdministerIntent(
    hardStop: hardStop,
    enqueue: !hardStop && !softBlocked,
    endpoint: '/clinical/mar/$maId/administer-with-scan',
    body: {
      'scanned_patient_uid': scannedPatientUid,
      'scanned_barcode': scannedBarcode,
      if (overrideReason != null && overrideReason.trim().isNotEmpty)
        'override_reason': overrideReason.trim(),
      'administered_at': at.toUtc().toIso8601String(),
    },
    rights: rights,
  );
}
