// lib/core/services/prescription_payloads.dart
//
// Pure POST /prescriptions/create request-body builder, shared by the online e-Rx
// submit path (prescriptions_screen._submit) and the offline enqueue path
// (buildOfflineRxIntent). Keeping the body in ONE place guarantees the queued offline
// request is byte-identical to the online one. No Flutter imports.
//
// Reproduces the screen's CURRENT inline body EXACTLY: the screen does NOT send
// admission_id or visit_type; `diagnosis` is always present (may be empty); `clinical_notes`
// is an always-present key whose value is null when empty.

/// Build the POST /prescriptions/create body for an e-prescription (multi-item).
Map<String, dynamic> buildPrescriptionBody({
  required int patientId,
  required int doctorId,
  int? appointmentId,
  required String diagnosis,
  String? clinicalNotes,
  required List<Map<String, dynamic>> medications,
  String? followUpDate,
  String? followUpNotes,
  Map<String, dynamic>? override,
  Map<String, dynamic>? vitals,
}) {
  return {
    'patient_id': patientId,
    'doctor_id': doctorId,
    'appointment_id': ?appointmentId,
    'diagnosis': diagnosis,
    'clinical_notes': clinicalNotes,
    'medications': medications,
    'follow_up_date': ?followUpDate,
    if (followUpNotes != null && followUpNotes.isNotEmpty) 'follow_up_notes': followUpNotes,
    'override': ?override,
    'vitals': ?vitals,
  };
}
