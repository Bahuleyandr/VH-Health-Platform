class SpecimenScanIntent {
  const SpecimenScanIntent({
    required this.hardStop,
    required this.submit,
    required this.enqueue,
    required this.endpoint,
    required this.body,
    required this.failedRights,
  });

  final bool hardStop;
  final bool submit;
  final bool enqueue;
  final String endpoint;
  final Map<String, dynamic> body;
  final List<String> failedRights;
}

SpecimenScanIntent buildSpecimenScanIntent({
  required int investigationId,
  required String scannedPatientUid,
  required String tubeBarcode,
  String? expectedPatientUid,
  String? notes,
}) {
  final patientUid = scannedPatientUid.trim();
  final barcode = tubeBarcode.trim();
  final failedRights = <String>[
    if (!_sameCode(expectedPatientUid, patientUid)) 'patient',
  ];
  final hardStop = failedRights.isNotEmpty;
  final canSubmit =
      !hardStop &&
      investigationId > 0 &&
      patientUid.isNotEmpty &&
      barcode.isNotEmpty;

  return SpecimenScanIntent(
    hardStop: hardStop,
    submit: canSubmit,
    enqueue: canSubmit,
    endpoint: '/lab/samples/$investigationId/collect',
    body: {
      'scanned_patient_uid': patientUid,
      'sample_barcode': barcode,
      if (notes != null && notes.trim().isNotEmpty)
        'collected_notes': notes.trim(),
    },
    failedRights: failedRights,
  );
}

bool _sameCode(String? expected, String scanned) {
  final cleanedExpected = expected?.trim();
  if (cleanedExpected == null || cleanedExpected.isEmpty) return true;
  return cleanedExpected.toLowerCase() == scanned.trim().toLowerCase();
}
