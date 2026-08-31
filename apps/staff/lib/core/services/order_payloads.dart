// lib/core/services/order_payloads.dart
//
// Pure POST /emr/orders request-body builders, shared by the online API method
// and encrypted local-draft serialization. Local drafts are never submitted or
// queued automatically; reopening requires a new online user action.

/// Canonical ward-supply units available at medication-order capture.
///
/// The clinician must select one explicitly. In particular, neither the drug
/// form nor a catalog pack-size string is safe enough to infer the unit that
/// pharmacy should issue to the ward.
const medicationWardSupplyUnits = <String>[
  'tablet',
  'capsule',
  'ampoule',
  'vial',
  'bag',
  'prefilled syringe',
  'cartridge',
  'mL',
  'dose',
  'patch',
  'actuation',
  'spray',
  'application',
  'bottle',
  'tube',
  'sachet',
  'suppository',
  'drop',
  'kit',
  'each',
];

enum MedicationWardSupplyValidationFailure {
  quantityRequired,
  quantityInvalid,
  unitRequired,
  unitInvalid,
}

double? parseMedicationWardSupplyQuantity(Object? raw) {
  if (raw == null) return null;
  final text = raw.toString().trim();
  if (text.isEmpty ||
      !RegExp(r'^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$').hasMatch(text)) {
    return null;
  }
  final quantity = double.tryParse(text);
  if (quantity == null ||
      !quantity.isFinite ||
      quantity <= 0 ||
      quantity > 99999999.99) {
    return null;
  }
  return quantity;
}

String? canonicalMedicationWardSupplyUnit(Object? raw) {
  final value = raw?.toString().trim() ?? '';
  if (value.isEmpty) return null;
  for (final unit in medicationWardSupplyUnits) {
    if (unit.toLowerCase() == value.toLowerCase()) return unit;
  }
  return null;
}

MedicationWardSupplyValidationFailure? validateMedicationWardSupply({
  required Object? quantity,
  required Object? unit,
}) {
  if (quantity == null || quantity.toString().trim().isEmpty) {
    return MedicationWardSupplyValidationFailure.quantityRequired;
  }
  if (parseMedicationWardSupplyQuantity(quantity) == null) {
    return MedicationWardSupplyValidationFailure.quantityInvalid;
  }
  if (unit == null || unit.toString().trim().isEmpty) {
    return MedicationWardSupplyValidationFailure.unitRequired;
  }
  if (canonicalMedicationWardSupplyUnit(unit) == null) {
    return MedicationWardSupplyValidationFailure.unitInvalid;
  }
  return null;
}

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
  required num quantityRequested,
  required String unit,
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
  final supplyQuantity = parseMedicationWardSupplyQuantity(quantityRequested);
  if (supplyQuantity == null) {
    throw ArgumentError.value(
      quantityRequested,
      'quantityRequested',
      'must be positive with at most two decimal places',
    );
  }
  final supplyUnit = canonicalMedicationWardSupplyUnit(unit);
  if (supplyUnit == null) {
    throw ArgumentError.value(
      unit,
      'unit',
      'must be an explicitly selected medication ward-supply unit',
    );
  }
  if (encounterId != null &&
      encounterId.trim().isNotEmpty &&
      catalogId == null) {
    throw ArgumentError.value(
      catalogId,
      'catalogId',
      'is required for an encounter-bound medication order',
    );
  }
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
      'quantity_requested': supplyQuantity,
      'unit': supplyUnit,
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
