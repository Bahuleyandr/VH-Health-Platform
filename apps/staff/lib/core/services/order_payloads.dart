// lib/core/services/order_payloads.dart
//
// Pure POST /emr/orders request-body builders, shared by the online API method
// (MedicalApiService.createInpatientMedicationOrder) and the offline enqueue
// path (buildOfflineOrderIntent). Keeping the body in ONE place guarantees the
// queued offline request is byte-identical to the online one. No Flutter imports.

/// Build the POST /emr/orders body for a single inpatient MEDICATION order.
/// Field shape matches the canonical nested-`details` contract in
/// apps/backend orderRoutes.js. Optional fields are omitted when null.
Map<String, dynamic> buildInpatientMedicationOrderBody({
  required String patientUid,
  String? encounterId,
  required String medicationName,
  required String dose,
  required String route,
  required String frequency,
  int? durationDays,
  List<String>? doseTimes,
  String? foodTiming,
  String? instructions,
  int? catalogId,
  int? originalCatalogId,
  int? compositionId,
  String? compositionLabel,
  String? compositionConfidence,
  String? genericName,
  String? strength,
  String? strengthKey,
  String? form,
  String? formKey,
  String? releaseKey,
  bool doNotSubstitute = false,
  String priority = 'routine',
  required DateTime startDate,
}) {
  final shouldSendOriginalCatalogId =
      originalCatalogId != null &&
      catalogId != null &&
      originalCatalogId != catalogId;
  return {
    'patient_uid': patientUid,
    'encounter_id': ?encounterId,
    'order_type': 'medication',
    'priority': priority,
    'start_date': startDate.toUtc().toIso8601String(),
    'details': {
      'medication_name': medicationName,
      'dose': dose,
      'route': route,
      'frequency': frequency,
      'duration_days': ?durationDays,
      'dose_times': ?doseTimes,
      'food_timing': ?foodTiming,
      'instructions': ?instructions,
      'catalog_id': ?catalogId,
      if (shouldSendOriginalCatalogId) 'original_catalog_id': originalCatalogId,
      'composition_id': ?compositionId,
      'composition_label': ?compositionLabel,
      'composition_confidence': ?compositionConfidence,
      'generic_name': ?genericName,
      'strength': ?strength,
      'strength_key': ?strengthKey,
      'form': ?form,
      'form_key': ?formKey,
      'release_key': ?releaseKey,
      if (doNotSubstitute) 'do_not_substitute': true,
    },
  };
}
