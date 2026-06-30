/// Client-side 5-rights for OFFLINE bedside MAR. A faithful port of the server's
/// evaluate5Rights (apps/backend/src/services/clinical/marFiveRightsService.js)
/// so a nurse gets the SAME safety check offline. The server re-verifies fully on
/// drain. Fidelity note: the server's `vhmp-` pack-barcode drug match needs a
/// pharmacy lookup unavailable offline, so offline drug-right is name-match ONLY
/// (never stronger than online).
const int kFiveRightsWindowMinutes = 60;

String _norm(String? s) => (s ?? '').trim().toLowerCase();

class FiveRights {
  const FiveRights({
    required this.patient,
    required this.drug,
    required this.dose,
    required this.route,
    required this.time,
  });
  final bool patient, drug, dose, route, time;
  bool get allPassed => patient && drug && dose && route && time;
  Map<String, bool> toMap() => {
    'patient': patient,
    'drug': drug,
    'dose': dose,
    'route': route,
    'time': time,
  };
}

/// [dose] is a cached MAR row (id, patient_uid, medication_name, dose|dosage,
/// route, scheduled_time). [at] is the bedside time (used for the time-right and
/// later sent as administered_at). [windowMinutes] defaults to the server's 60.
FiveRights evaluateFiveRights({
  required Map<String, dynamic> dose,
  required String scannedPatientUid,
  required String scannedBarcode,
  required DateTime at,
  int windowMinutes = kFiveRightsWindowMinutes,
}) {
  final rightPatient =
      _norm(dose['patient_uid'] as String?) == _norm(scannedPatientUid);

  final medName = _norm(dose['medication_name'] as String?);
  final scanned = _norm(scannedBarcode);
  final rightDrug =
      medName.isNotEmpty &&
      (medName.contains(scanned) || scanned.contains(medName));

  final doseStr = dose['dose'] as String? ?? dose['dosage'] as String?;
  final rightDose = doseStr != null && doseStr.trim().isNotEmpty;

  final routeStr = dose['route'] as String?;
  final rightRoute = routeStr != null && routeStr.trim().isNotEmpty;

  var rightTime = true;
  final schedStr = dose['scheduled_time'] as String?;
  final sched = schedStr == null ? null : DateTime.tryParse(schedStr);
  if (sched != null) {
    final minutes = at.toUtc().difference(sched.toUtc()).inMinutes;
    rightTime = minutes.abs() <= windowMinutes;
  }

  return FiveRights(
    patient: rightPatient,
    drug: rightDrug,
    dose: rightDose,
    route: rightRoute,
    time: rightTime,
  );
}
