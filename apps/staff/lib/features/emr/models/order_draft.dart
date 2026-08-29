// lib/features/emr/models/order_draft.dart
//
// Pure CPOE composer logic (roadmap E1): the basket draft model, payload
// builders for POST /emr/orders/bulk, order-set item mapping, catalog row
// mapping, CDS alert partitioning, and the medication-role gate. No Flutter
// imports beyond foundation — everything here is unit-testable without
// plugin channels (test/features/emr/order_composer_test.dart), following
// the vitals_chart_screen.dart pure-helper pattern.

import '../../../core/services/order_payloads.dart';
import '../../../core/utils/api_error_codes.dart';

/// Mirrors MEDICATION_ORDER_WRITE_ROLES in apps/backend orderRoutes.js.
/// Keep in sync — the server gate is canonical; this only shapes the UI.
const kMedicationOrderWriteRoles = <String>{
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
};

bool canPrescribeMedicationOrders(String? role) =>
    kMedicationOrderWriteRoles.contains(role?.trim().toUpperCase() ?? '');

bool medicationHasAuthoritativeCatalog(OrderDraft draft) {
  if (draft.orderType != 'medication') return true;
  final raw = draft.details['catalog_id'];
  final id = raw is int ? raw : int.tryParse(raw?.toString() ?? '');
  return id != null && id > 0;
}

bool medicationHasAuthoritativeCatalogRoute(OrderDraft draft) {
  if (draft.orderType != 'medication') return true;
  return draft.details['route']?.toString().trim().isNotEmpty == true;
}

enum MedicationClinicalDirectionsValidationFailure {
  doseRequired,
  routeRequired,
}

MedicationClinicalDirectionsValidationFailure?
medicationClinicalDirectionsFailure(OrderDraft draft) {
  if (draft.orderType != 'medication') return null;
  if (draft.details['dose']?.toString().trim().isNotEmpty != true) {
    return MedicationClinicalDirectionsValidationFailure.doseRequired;
  }
  if (!medicationHasAuthoritativeCatalogRoute(draft)) {
    return MedicationClinicalDirectionsValidationFailure.routeRequired;
  }
  return null;
}

MedicationWardSupplyValidationFailure? medicationWardSupplyFailure(
  OrderDraft draft,
) {
  if (draft.orderType != 'medication') return null;
  return validateMedicationWardSupply(
    quantity: draft.details['quantity_requested'],
    unit: draft.details['unit'],
  );
}

/// Persisted order-set payloads never prove that their catalog identity is
/// still active. Only pass [liveCatalogSelected] after the clinician selects a
/// row returned by the current catalog search in this screen session.
bool medicationOrderSetPayloadNeedsReconciliation(
  Map<String, dynamic> payload, {
  bool liveCatalogSelected = false,
}) {
  final draft = orderDraftFromSetItem({'kind': 'med', 'payload': payload});
  return !liveCatalogSelected ||
      draft == null ||
      !medicationHasAuthoritativeCatalog(draft) ||
      medicationClinicalDirectionsFailure(draft) != null ||
      medicationWardSupplyFailure(draft) != null;
}

Map<String, dynamic> reconcileMedicationOrderSetPayload({
  required Map<String, dynamic> payload,
  required Map<String, dynamic> catalogRow,
  required Object? dose,
  required Object? quantityRequested,
  required Object? unit,
}) {
  final catalogDraft = orderDraftFromMedCatalogRow(catalogRow);
  if (!medicationHasAuthoritativeCatalog(catalogDraft)) {
    throw ArgumentError.value(
      catalogRow,
      'catalogRow',
      'must contain an authoritative pharmacy catalog id',
    );
  }
  final prescribedDose = dose?.toString().trim() ?? '';
  if (prescribedDose.isEmpty) {
    throw ArgumentError.value(
      dose,
      'dose',
      'must be an explicit non-empty prescribed dose',
    );
  }
  final catalogRoute = catalogDraft.details['route']?.toString().trim() ?? '';
  if (catalogRoute.isEmpty) {
    throw ArgumentError.value(
      catalogRow,
      'catalogRow',
      'must contain the authoritative medication route',
    );
  }
  final quantity = parseMedicationWardSupplyQuantity(quantityRequested);
  if (quantity == null) {
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

  final selected = catalogDraft.details;
  final medicationName = selected['medication_name']?.toString().trim() ?? '';
  final reconciled = Map<String, dynamic>.from(payload)
    ..remove('catalogId')
    ..remove('quantity')
    ..remove('qty')
    ..remove('units')
    ..['drug'] = medicationName
    ..['medication_name'] = medicationName
    ..['dose'] = prescribedDose
    ..['route'] = catalogRoute
    ..['catalog_id'] = selected['catalog_id']
    ..['quantity_requested'] = quantity
    ..['unit'] = supplyUnit;
  for (final key in const [
    'composition_id',
    'composition_label',
    'composition_confidence',
    'generic_name',
    'strength',
    'strength_key',
    'form',
    'form_key',
    'release_key',
  ]) {
    final value = selected[key];
    if (value != null && value.toString().trim().isNotEmpty) {
      reconciled[key] = value;
    }
  }
  return reconciled;
}

/// One un-signed order in the composer basket.
class OrderDraft {
  OrderDraft({
    required this.orderType,
    required this.details,
    this.priority = 'routine',
    this.notes,
    this.source = 'manual',
  });

  /// Canonical backend order_type ('medication', 'investigation',
  /// 'radiology', 'ecg', 'consultation', 'nursing', 'diet', ...).
  final String orderType;
  final Map<String, dynamic> details;
  String priority;
  final String? notes;

  /// 'catalog' | 'order-set' | 'manual' — provenance chip in the basket.
  final String source;

  /// Advisory CDS pre-check state (null = not yet checked / unavailable).
  List<Map<String, dynamic>>? cdsAlerts;
  bool checkingCds = false;

  /// True when the advisory CDS pre-check FAILED to run (network/API error).
  /// Distinct from `cdsAlerts == []` ("ran, no alerts") — the basket shows a
  /// "safety pre-check unavailable" chip so a silent CDS outage can't read
  /// as a clean bill of health. The server still re-runs the full safety
  /// engine at submit either way.
  bool cdsUnavailable = false;

  String get title {
    switch (orderType) {
      case 'medication':
        return details['medication_name']?.toString() ?? '—';
      case 'investigation':
      case 'radiology':
      case 'ecg':
        return details['test_name']?.toString() ?? '—';
      case 'consultation':
        return details['specialty']?.toString() ?? '—';
      default:
        return details['description']?.toString() ?? '—';
    }
  }

  String get subtitle {
    if (orderType == 'medication') {
      return [
        details['dose'],
        details['route'],
        details['frequency'],
      ].where((e) => e != null && '$e'.isNotEmpty).join(' · ');
    }
    if (orderType == 'consultation') {
      return details['reason']?.toString() ?? '';
    }
    return [
      details['test_code'],
      details['reason'],
      details['frequency'],
    ].where((e) => e != null && '$e'.isNotEmpty).join(' · ');
  }
}

/// Build one item for POST /emr/orders/bulk from a draft. Field names match
/// the canonical nested-`details` contract in orderRoutes.js.
Map<String, dynamic> buildBulkOrderItem(
  OrderDraft draft, {
  required String patientUid,
  String? encounterId,
}) {
  final details = Map<String, dynamic>.from(draft.details)
    ..removeWhere((_, v) => v == null || (v is String && v.trim().isEmpty));
  return {
    'patient_uid': patientUid,
    if (encounterId != null && encounterId.isNotEmpty)
      'encounter_id': encounterId,
    'order_type': draft.orderType,
    'priority': draft.priority,
    'details': details,
    if (draft.notes != null && draft.notes!.trim().isNotEmpty)
      'notes': draft.notes!.trim(),
  };
}

/// Map a productivity order-set item ({kind, payload}) to a draft. Returns
/// null for kinds that are not placeable clinical orders (notes, other).
/// Kind vocabulary comes from clinical_order_set_items.kind — see
/// order_sets_screen.dart `_kindColours`.
OrderDraft? orderDraftFromSetItem(Map<String, dynamic> item) {
  final kind = item['kind']?.toString() ?? '';
  final payload = item['payload'] is Map
      ? Map<String, dynamic>.from(item['payload'] as Map)
      : <String, dynamic>{};
  switch (kind) {
    case 'med':
      final name = payload['drug'] ?? payload['medication_name'];
      if (name == null || '$name'.trim().isEmpty) return null;
      return OrderDraft(
        orderType: 'medication',
        source: 'order-set',
        details: {
          'medication_name': '$name',
          'dose': payload['dose'],
          'route': payload['route'],
          'frequency': payload['frequency'],
          'duration_days': payload['duration_days'],
          'instructions': payload['instructions'],
          'catalog_id': payload['catalog_id'] ?? payload['catalogId'],
          'quantity_requested': payload['quantity_requested'],
          'unit':
              payload['unit'] ??
              payload['quantity_unit'] ??
              payload['dispense_unit'] ??
              payload['supply_unit'],
        },
      );
    case 'lab':
      final name = payload['test_name'] ?? payload['test_code'];
      if (name == null || '$name'.trim().isEmpty) return null;
      return OrderDraft(
        orderType: 'investigation',
        source: 'order-set',
        details: {
          'test_name': '$name',
          'test_code': payload['test_code'],
          'fasting_required': payload['fasting_required'],
        },
      );
    case 'radiology':
      final study = payload['study'] ?? payload['test_name'];
      if (study == null || '$study'.trim().isEmpty) return null;
      return OrderDraft(
        orderType: 'radiology',
        source: 'order-set',
        details: {'test_name': '$study', 'reason': payload['reason']},
      );
    case 'consult':
      final specialty = payload['specialty'] ?? payload['department'];
      if (specialty == null || '$specialty'.trim().isEmpty) return null;
      return OrderDraft(
        orderType: 'consultation',
        source: 'order-set',
        details: {'specialty': '$specialty', 'reason': payload['reason']},
      );
    case 'diet':
      final label = payload['label'] ?? payload['description'];
      if (label == null || '$label'.trim().isEmpty) return null;
      return OrderDraft(
        orderType: 'diet',
        source: 'order-set',
        details: {'description': '$label'},
      );
    case 'nursing':
    case 'vitals':
    case 'monitor':
      final label = payload['label'] ?? payload['description'];
      if (label == null || '$label'.trim().isEmpty) return null;
      return OrderDraft(
        orderType: 'nursing',
        source: 'order-set',
        details: {'description': '$label', 'frequency': payload['frequency']},
      );
    default:
      return null; // 'note', 'other' — not placeable clinical orders.
  }
}

/// Map a pharmacy formulary row (GET /pharmacy-orders/catalog) to a
/// medication draft pre-fill.
OrderDraft orderDraftFromMedCatalogRow(Map<String, dynamic> row) {
  final name =
      row['name'] ??
      row['medication_name'] ??
      row['drug_name'] ??
      row['generic_name'] ??
      '';
  return OrderDraft(
    orderType: 'medication',
    source: 'catalog',
    details: {
      'medication_name': '$name',
      'dose': row['strength'],
      'route': row['route'] ?? row['default_route'],
      'catalog_id': row['catalog_id'] ?? row['id'],
      'composition_id': row['composition_id'],
      'composition_label': row['composition_label'],
      'composition_confidence': row['composition_confidence'],
      'generic_name': row['generic_name'],
      'strength': row['strength'],
      'strength_key': row['strength_key'],
      'form': row['form'],
      'form_key': row['form_key'],
      'release_key': row['release_key'],
    },
  );
}

/// Map an investigation_test_catalog row (GET /investigations/catalog) to a
/// draft. Imaging categories become radiology orders, ECG/cardiology becomes
/// an ecg order; everything else is a lab investigation.
OrderDraft orderDraftFromTestCatalogRow(Map<String, dynamic> row) {
  final category = row['category']?.toString().toLowerCase() ?? '';
  const imaging = [
    'radiology',
    'imaging',
    'x-ray',
    'xray',
    'ct',
    'mri',
    'ultrasound',
    'usg',
  ];
  final String orderType;
  if (imaging.any(category.contains)) {
    orderType = 'radiology';
  } else if (category.contains('ecg') || category.contains('cardiology')) {
    orderType = 'ecg';
  } else {
    orderType = 'investigation';
  }
  return OrderDraft(
    orderType: orderType,
    source: 'catalog',
    details: {
      'test_name': row['name']?.toString() ?? '—',
      'test_code': row['code'],
      'fasting_required': row['requires_fasting'] == true ? true : null,
    },
  );
}

/// Partition advisory pre-check alerts (cdsEngine.checkOrder →
/// {safe, alerts:[{severity: critical|warning|info, title, description}]}).
/// `info` entries are dropped — they are noise at composition time.
({List<Map<String, dynamic>> criticals, List<Map<String, dynamic>> cautions})
classifyPrecheckAlerts(List<dynamic> alerts) {
  final criticals = <Map<String, dynamic>>[];
  final cautions = <Map<String, dynamic>>[];
  for (final a in alerts) {
    if (a is! Map) continue;
    final alert = Map<String, dynamic>.from(a);
    switch (alert['severity']?.toString().toLowerCase()) {
      case 'critical':
        criticals.add(alert);
      case 'warning':
        cautions.add(alert);
      default:
        break;
    }
  }
  return (criticals: criticals, cautions: cautions);
}

/// Parse the structured payload of a 400 CDS_BLOCKER error envelope
/// ({success:false, code:'CDS_BLOCKER', details:{order_index?, blockers,
/// warnings}}) as raised by createOrder/createOrdersBulk.
({int? orderIndex, List<dynamic> blockers, List<dynamic> warnings})
parseCdsBlockerDetails(dynamic raw) {
  if (raw is! Map) {
    return (orderIndex: null, blockers: const [], warnings: const []);
  }
  final details = raw['details'];
  if (details is! Map) {
    return (orderIndex: null, blockers: const [], warnings: const []);
  }
  final idx = details['order_index'];
  return (
    orderIndex: idx is int ? idx : int.tryParse('$idx'),
    blockers: details['blockers'] is List
        ? details['blockers'] as List
        : const [],
    warnings: details['warnings'] is List
        ? details['warnings'] as List
        : const [],
  );
}

/// True when the error envelope is the phone-mode clinical-write gate
/// (rejectMobileClinicalWriteMiddleware).
bool isDeviceWriteGate(dynamic raw) =>
    isDeviceTypeWriteGateCode(apiErrorCodeFromRaw(raw));

/// Title + detail line for a persisted clinical_orders row. Canonical rows
/// carry a nested `details` JSON object; very old rows (pre-nesting) may
/// still have flat fields — both shapes render.
({String title, String subtitle}) orderDisplayFields(
  Map<String, dynamic> order,
) {
  final details = order['details'] is Map
      ? Map<String, dynamic>.from(order['details'] as Map)
      : <String, dynamic>{};
  dynamic pick(List<String> keys) {
    for (final k in keys) {
      final v = details[k] ?? order[k];
      if (v != null && '$v'.trim().isNotEmpty) return v;
    }
    return null;
  }

  final title =
      pick(const [
        'medication_name',
        'medication',
        'test_name',
        'investigation',
        'specialty',
        'description',
        'title',
      ])?.toString() ??
      '';

  final type = order['order_type']?.toString() ?? '';
  final List<dynamic> parts;
  if (type == 'medication') {
    parts = [
      pick(const ['dose', 'dosage']),
      pick(const ['route']),
      pick(const ['frequency']),
      pick(const ['duration_days', 'duration']),
    ];
  } else if (type == 'consultation') {
    parts = [
      pick(const ['reason']),
    ];
  } else {
    parts = [
      pick(const ['test_code']),
      pick(const ['reason', 'clinical_indication']),
      pick(const ['frequency']),
    ];
  }
  final subtitle = parts
      .where((e) => e != null && '$e'.trim().isNotEmpty)
      .join(' | ');
  return (title: title, subtitle: subtitle);
}
