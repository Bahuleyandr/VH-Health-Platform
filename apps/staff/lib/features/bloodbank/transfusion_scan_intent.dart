class TransfusionScanIntent {
  const TransfusionScanIntent({
    required this.hardStop,
    required this.submit,
    required this.body,
    required this.failedRights,
  });

  final bool hardStop;
  final bool submit;
  final Map<String, dynamic> body;
  final List<String> failedRights;
}

TransfusionScanIntent buildTransfusionScanIntent({
  required int requestId,
  required String verifierRole,
  required String scannedPatientUid,
  required String scannedUnitNumber,
  String? expectedPatientUid,
  String? expectedUnitNumber,
  String? overrideReason,
}) {
  final patientUid = scannedPatientUid.trim();
  final unitNumber = scannedUnitNumber.trim().toUpperCase();
  final failedRights = <String>[
    if (!_sameCode(expectedPatientUid, patientUid)) 'patient',
    if (!_sameCode(expectedUnitNumber, unitNumber)) 'unit',
  ];
  final hardStop = failedRights.isNotEmpty;
  final canSubmit =
      !hardStop &&
      requestId > 0 &&
      verifierRole.trim().isNotEmpty &&
      patientUid.isNotEmpty &&
      unitNumber.isNotEmpty;

  return TransfusionScanIntent(
    hardStop: hardStop,
    submit: canSubmit,
    body: {
      'verifier_role': verifierRole.trim(),
      'scanned_patient_uid': patientUid,
      'scanned_unit_number': unitNumber,
      if (overrideReason != null && overrideReason.trim().isNotEmpty)
        'override_reason': overrideReason.trim(),
    },
    failedRights: failedRights,
  );
}

bool _sameCode(String? expected, String scanned) {
  final cleanedExpected = expected?.trim();
  if (cleanedExpected == null || cleanedExpected.isEmpty) return true;
  return cleanedExpected.toLowerCase() == scanned.trim().toLowerCase();
}
