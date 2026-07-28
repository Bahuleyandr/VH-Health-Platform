import 'package:vhhealth_core/services/mar_five_rights.dart';

/// Pure decision for the offline administer path.
///
/// C0A never turns this decision into a replayable write. It only decides
/// whether the scan is a hard stop or may proceed to the paper fallback.
class OfflineAdministerIntent {
  const OfflineAdministerIntent({
    required this.hardStop,
    required this.showPaperFallback,
    required this.rights,
  });
  final bool hardStop; // patient/drug mismatch → abort + re-scan
  final bool showPaperFallback;
  final FiveRights rights;
}

OfflineAdministerIntent buildOfflineAdministerIntent({
  required Map<String, dynamic> dose,
  required String scannedPatientUid,
  required String scannedBarcode,
  required DateTime at,
}) {
  final rights = evaluateFiveRights(
    dose: dose,
    scannedPatientUid: scannedPatientUid,
    scannedBarcode: scannedBarcode,
    at: at,
  );
  final hardStop = !rights.patient || !rights.drug;
  return OfflineAdministerIntent(
    hardStop: hardStop,
    showPaperFallback: !hardStop,
    rights: rights,
  );
}
