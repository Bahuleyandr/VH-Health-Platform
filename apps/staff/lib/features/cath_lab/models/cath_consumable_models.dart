class CathConsumableCatalogItem {
  const CathConsumableCatalogItem({
    required this.id,
    required this.itemName,
    required this.category,
    required this.manufacturer,
    required this.model,
    required this.isImplant,
    required this.batchTracked,
    this.inventoryItemId,
    this.skuCode = '',
    this.unitLabel = 'each',
    this.active = true,
  });

  final int id;
  final String itemName;
  final String category;
  final String manufacturer;
  final String model;
  final bool isImplant;
  final bool batchTracked;
  final int? inventoryItemId;
  final String skuCode;
  final String unitLabel;
  final bool active;

  String get supportingLabel => [
    if (manufacturer.isNotEmpty) manufacturer,
    if (model.isNotEmpty) model,
    if (skuCode.isNotEmpty) skuCode,
  ].join(' - ');

  factory CathConsumableCatalogItem.fromJson(Map<String, dynamic> json) {
    return CathConsumableCatalogItem(
      id: _asInt(json['id']) ?? 0,
      itemName: _firstText(json, const ['item_name', 'name', 'display_name']),
      category: _firstText(json, const ['category'], fallback: 'other'),
      manufacturer: _firstText(json, const ['manufacturer']),
      model: _firstText(json, const ['model', 'model_number']),
      isImplant: _asBool(json['is_implant']),
      batchTracked: _asBool(json['batch_tracked']),
      inventoryItemId: _asInt(
        json['inventory_item_id'] ?? json['pharmacy_inventory_item_id'],
      ),
      skuCode: _firstText(json, const [
        'sku_code',
        'inventory_sku',
        'inventory_sku_code',
      ]),
      unitLabel: _firstText(json, const [
        'unit_label',
        'inventory_unit_label',
        'default_unit',
      ], fallback: 'each'),
      active: json.containsKey('active')
          ? _asBool(json['active'])
          : _text(json['status']).toLowerCase() != 'retired',
    );
  }
}

class CathInventoryBatch {
  const CathInventoryBatch({
    required this.id,
    required this.batchNumber,
    required this.lotNumber,
    required this.expiryDate,
    required this.remainingQuantity,
    required this.status,
    this.inventoryItemId,
    this.unitLabel = 'each',
  });

  final int id;
  final int? inventoryItemId;
  final String batchNumber;
  final String lotNumber;
  final DateTime? expiryDate;
  final double remainingQuantity;
  final String status;
  final String unitLabel;

  factory CathInventoryBatch.fromJson(Map<String, dynamic> json) {
    return CathInventoryBatch(
      id: _asInt(json['id']) ?? 0,
      inventoryItemId: _asInt(json['inventory_item_id']),
      batchNumber: _firstText(json, const ['batch_number', 'batch_no']),
      lotNumber: _firstText(json, const ['lot_number', 'lot_no']),
      expiryDate: _asDate(json['expiry_date']),
      remainingQuantity: _asDouble(json['remaining_quantity']) ?? 0,
      status: _text(json['status'], fallback: 'in_stock'),
      unitLabel: _text(json['unit_label'], fallback: 'each'),
    );
  }
}

class CathCaseConsumableUsage {
  const CathCaseConsumableUsage({
    required this.id,
    required this.caseId,
    required this.catalogItemId,
    required this.itemName,
    required this.category,
    required this.quantity,
    required this.unitLabel,
    required this.batchNumber,
    required this.lotNumber,
    required this.serialNumber,
    required this.wasted,
    required this.wastageReason,
    required this.usedByName,
    required this.isImplant,
    required this.batchTracked,
    required this.inventoryWarning,
    required this.inventoryDecrementStatus,
    this.procedureLogId,
    this.inventoryBatchId,
    this.expiryDate,
    this.recordedAt,
    this.deviceTag = '',
    this.reuseCycle,
    this.postUseDisposition = '',
    this.deviceStatus = '',
    this.deviceExposureFlag = false,
    this.allowedPostUse,
  });

  final int id;
  final int caseId;
  final int catalogItemId;
  final int? procedureLogId;
  final int? inventoryBatchId;
  final String itemName;
  final String category;
  final double quantity;
  final String unitLabel;
  final String batchNumber;
  final String lotNumber;
  final DateTime? expiryDate;
  final String serialNumber;
  final bool wasted;
  final String wastageReason;
  final String usedByName;
  final bool isImplant;
  final bool batchTracked;
  final String inventoryWarning;
  final String inventoryDecrementStatus;
  final DateTime? recordedAt;
  final String deviceTag;

  /// 0 on a first use, 1+ once the row consumed a reprocessed device. Absent
  /// on rows the backend has not decorated with reuse state at all.
  final int? reuseCycle;
  final String postUseDisposition;
  final String deviceStatus;
  final bool deviceExposureFlag;
  final CathPostUseOptions? allowedPostUse;

  bool get hasInventoryWarning => inventoryWarning.trim().isNotEmpty;

  bool get isReused => reuseCycle != null && reuseCycle! >= 1;

  factory CathCaseConsumableUsage.fromJson(Map<String, dynamic> json) {
    final nestedRaw = json['catalog_item'] ?? json['catalog'];
    final nested = nestedRaw is Map
        ? Map<String, dynamic>.from(nestedRaw)
        : const <String, dynamic>{};
    Object? value(String key) => json[key] ?? nested[key];

    return CathCaseConsumableUsage(
      id: _asInt(json['id']) ?? 0,
      caseId: _asInt(json['case_id']) ?? 0,
      catalogItemId: _asInt(json['catalog_item_id'] ?? nested['id']) ?? 0,
      procedureLogId: _asInt(json['procedure_log_id']),
      inventoryBatchId: _asInt(json['inventory_batch_id']),
      itemName: _firstText(json, const [
        'item_name',
        'catalog_item_name',
        'display_name',
      ], fallback: _firstText(nested, const ['item_name', 'name'])),
      category: _text(value('category'), fallback: 'other'),
      quantity: _asDouble(json['quantity']) ?? 0,
      unitLabel: _text(
        json['unit_label'] ??
            json['inventory_unit_label'] ??
            nested['unit_label'],
        fallback: 'each',
      ),
      batchNumber: _firstText(json, const ['batch_number', 'batch_no']),
      lotNumber: _firstText(json, const ['lot_number', 'lot_no']),
      expiryDate: _asDate(json['expiry_date']),
      serialNumber: _text(json['serial_number']),
      wasted: _asBool(json['wasted']),
      wastageReason: _firstText(json, const ['wastage_reason', 'waste_reason']),
      usedByName: _firstText(json, const ['used_by_name', 'recorded_by_name']),
      isImplant: _asBool(value('is_implant')),
      batchTracked: _asBool(value('batch_tracked')),
      inventoryWarning: _text(json['inventory_warning']),
      inventoryDecrementStatus: _text(
        json['inventory_decrement_status'] ?? json['inventory_status'],
      ),
      recordedAt: _asDate(
        json['used_at'] ?? json['recorded_at'] ?? json['created_at'],
      ),
      deviceTag: _text(json['device_tag']),
      reuseCycle: _asInt(json['reuse_cycle']),
      postUseDisposition: _text(json['post_use_disposition']),
      deviceStatus: _text(json['device_status']),
      deviceExposureFlag: _asBool(json['device_exposure_flag']),
      allowedPostUse: json['allowed_post_use'] is Map
          ? CathPostUseOptions.fromJson(
              Map<String, dynamic>.from(json['allowed_post_use'] as Map),
            )
          : null,
    );
  }
}

class CathConsumableUsageDraft {
  const CathConsumableUsageDraft({
    required this.catalogItemId,
    required this.quantity,
    required this.wasted,
    this.procedureLogId,
    this.inventoryBatchId,
    this.batchNumber,
    this.lotNumber,
    this.expiryDate,
    this.serialNumber,
    this.wastageReason,
    this.reusedDeviceTag,
    this.exposureAcknowledgementReason,
  });

  final int catalogItemId;
  final double quantity;
  final int? procedureLogId;
  final int? inventoryBatchId;
  final String? batchNumber;
  final String? lotNumber;
  final DateTime? expiryDate;
  final String? serialNumber;
  final bool wasted;
  final String? wastageReason;

  /// Set only in reused-device capture mode. The backend rejects a draft that
  /// carries both this and any new-unit batch field
  /// (`CATH_CONSUMABLE_REUSE_FIELDS_CONFLICT`), so the sheet clears the batch
  /// side before it builds the draft rather than sending both.
  final String? reusedDeviceTag;
  final String? exposureAcknowledgementReason;

  Map<String, dynamic> toJson() => {
    'catalog_item_id': catalogItemId.toString(),
    'quantity': quantity,
    if (procedureLogId != null) 'procedure_log_id': procedureLogId.toString(),
    if (inventoryBatchId != null) 'inventory_batch_id': inventoryBatchId,
    if ((batchNumber ?? '').isNotEmpty) 'batch_number': batchNumber,
    if ((lotNumber ?? '').isNotEmpty) 'lot_number': lotNumber,
    if (expiryDate != null)
      'expiry_date': expiryDate!.toIso8601String().substring(0, 10),
    if ((serialNumber ?? '').isNotEmpty) 'serial_number': serialNumber,
    'wasted': wasted,
    if ((wastageReason ?? '').isNotEmpty) 'waste_reason': wastageReason,
    if ((reusedDeviceTag ?? '').isNotEmpty)
      'reused_device_tag': reusedDeviceTag,
    if ((exposureAcknowledgementReason ?? '').isNotEmpty)
      'exposure_acknowledgement': {'reason': exposureAcknowledgementReason},
  };
}

/// The patient's blood-borne restriction as the backend resolved it for this
/// case. `reasons` and `markers` come back empty for roles outside the
/// clinical-staff set while `status` and `validityDays` stay populated, so the
/// strip must render from `status` alone when the detail is withheld.
class CathReuseRestriction {
  const CathReuseRestriction({
    required this.status,
    required this.reasons,
    required this.validityDays,
  });

  /// `restricted` | `unknown` | `clear`.
  final String status;
  final List<String> reasons;
  final int validityDays;

  bool get isRestricted => status == 'restricted';
  bool get isUnknown => status == 'unknown';
  bool get isClear => status == 'clear';

  factory CathReuseRestriction.fromJson(Map<String, dynamic> json) {
    return CathReuseRestriction(
      status: _text(json['status'], fallback: 'unknown'),
      reasons: json['reasons'] is List
          ? (json['reasons'] as List)
                .map((e) => _text(e))
                .where((e) => e.isNotEmpty)
                .toList()
          : const [],
      validityDays: _asInt(json['validity_days']) ?? 90,
    );
  }
}

/// Mirror of `DISCARD_REASONS` in
/// `apps/backend/src/services/clinical/cathDeviceReuseService.js`, in the
/// backend's declared order. `cath_consumable_models_test.dart` pins this
/// list against that source so the two cannot silently drift apart again.
const cathDeviceDiscardReasons = [
  'max_cycles_reached',
  'bloodborne_exposure',
  'late_reactive_marker',
  'function_check_failed',
  'sterilization_failed',
  'damaged',
  'wasted',
  'policy_change',
  'other',
];

/// What the backend will accept for a usage row once the case is done with it.
/// The server recomputes this on every post-use call, so the client uses it to
/// shape the buttons, never as the authority.
class CathPostUseOptions {
  const CathPostUseOptions({
    required this.dispositions,
    required this.requiresAcknowledgement,
    required this.exposure,
    required this.reasonCodes,
    required this.unitsMax,
    this.discardReason,
    this.blockedCode,
  });

  /// Any of `reprocess` / `discard`; empty when neither is offered.
  final List<String> dispositions;
  final bool requiresAcknowledgement;
  final bool exposure;
  final List<String> reasonCodes;
  final int unitsMax;
  final String? discardReason;
  final String? blockedCode;

  bool get canReprocess => dispositions.contains('reprocess');
  bool get canDiscard => dispositions.contains('discard');
  bool get isEmpty => dispositions.isEmpty;

  factory CathPostUseOptions.fromJson(Map<String, dynamic> json) {
    List<String> list(Object? value) => value is List
        ? value.map((e) => _text(e)).where((e) => e.isNotEmpty).toList()
        : const [];
    final discardReason = _text(json['discard_reason']);
    final blockedCode = _text(json['blocked_code']);
    return CathPostUseOptions(
      dispositions: list(json['dispositions']),
      requiresAcknowledgement: _asBool(json['requires_acknowledgement']),
      exposure: _asBool(json['exposure']),
      reasonCodes: list(json['reason_codes']),
      unitsMax: _asInt(json['units_max']) ?? 0,
      discardReason: discardReason.isEmpty ? null : discardReason,
      blockedCode: blockedCode.isEmpty ? null : blockedCode,
    );
  }
}

class CathReprocessableDevice {
  const CathReprocessableDevice({
    required this.id,
    required this.deviceTag,
    required this.itemName,
    required this.category,
    required this.status,
    required this.cycleCount,
    required this.maxCycles,
    required this.exposureFlag,
    required this.exposureMarkers,
  });

  final int id;
  final String deviceTag;
  final String itemName;
  final String category;
  final String status;
  final int cycleCount;
  final int maxCycles;
  final bool exposureFlag;
  final List<String> exposureMarkers;

  factory CathReprocessableDevice.fromJson(Map<String, dynamic> json) {
    return CathReprocessableDevice(
      id: _asInt(json['id']) ?? 0,
      deviceTag: _text(json['device_tag']),
      itemName: _text(json['item_name']),
      category: _text(json['category'], fallback: 'other'),
      status: _text(json['status'], fallback: 'unknown'),
      cycleCount: _asInt(json['cycle_count']) ?? 0,
      maxCycles: _asInt(json['max_cycles_snapshot']) ?? 0,
      exposureFlag: _asBool(json['exposure_flag']),
      exposureMarkers: json['exposure_markers'] is List
          ? (json['exposure_markers'] as List).map((e) => _text(e)).toList()
          : const [],
    );
  }
}

class CathDeviceLookup {
  const CathDeviceLookup({
    required this.device,
    required this.reprocessable,
    required this.cyclesRemaining,
    required this.requiresAcknowledgement,
    required this.blocked,
  });

  final CathReprocessableDevice device;
  final bool reprocessable;
  final int cyclesRemaining;
  final bool requiresAcknowledgement;
  final bool blocked;

  bool get usable => device.status == 'available' && reprocessable && !blocked;

  factory CathDeviceLookup.fromJson(Map<String, dynamic> json) {
    final raw = json['device'];
    return CathDeviceLookup(
      device: CathReprocessableDevice.fromJson(
        raw is Map ? Map<String, dynamic>.from(raw) : const <String, dynamic>{},
      ),
      reprocessable: _asBool(json['reprocessable']),
      cyclesRemaining: _asInt(json['cycles_remaining']) ?? 0,
      requiresAcknowledgement: _asBool(json['requires_acknowledgement']),
      blocked: _asBool(json['blocked']),
    );
  }
}

/// The whole `GET /cath-lab/cases/:id/consumables` body: usage rows plus the
/// two case-level facts the reuse UI needs.
class CathCaseConsumablesPayload {
  const CathCaseConsumablesPayload({
    required this.usage,
    required this.restriction,
    required this.reprocessableCategories,
  });

  final List<CathCaseConsumableUsage> usage;
  final CathReuseRestriction restriction;
  final Set<String> reprocessableCategories;
}

class CathPostUseDraft {
  const CathPostUseDraft({
    required this.disposition,
    this.units,
    this.discardReason,
    this.discardNote,
    this.acknowledgementReason,
  });

  /// `reprocess` | `discard`.
  final String disposition;
  final int? units;
  final String? discardReason;
  final String? discardNote;
  final String? acknowledgementReason;

  Map<String, dynamic> toJson() => {
    'disposition': disposition,
    if (units != null) 'units': units,
    if ((discardReason ?? '').isNotEmpty) 'discard_reason': discardReason,
    if ((discardNote ?? '').isNotEmpty) 'discard_note': discardNote,
    if ((acknowledgementReason ?? '').isNotEmpty)
      'acknowledgement': {'reason': acknowledgementReason},
  };
}

class CathPostUseResult {
  const CathPostUseResult({
    required this.usageId,
    required this.disposition,
    required this.deviceTags,
    this.deviceAlreadyDiscarded = false,
  });

  final int usageId;
  final String disposition;
  final List<String> deviceTags;

  /// CSSD had already discarded the device before this call landed. The
  /// disposition IS recorded, so this is not a failure — but the operator's
  /// "sent to CSSD" mental model is wrong and the row must say so.
  final bool deviceAlreadyDiscarded;

  factory CathPostUseResult.fromJson(Map<String, dynamic> json) {
    final devices = json['devices'];
    return CathPostUseResult(
      usageId: _asInt(json['usage_id']) ?? 0,
      disposition: _text(json['disposition']),
      deviceAlreadyDiscarded: _asBool(json['device_already_discarded']),
      deviceTags: devices is List
          ? devices
                .whereType<Map>()
                .map((d) => _text(d['device_tag']))
                .where((tag) => tag.isNotEmpty)
                .toList()
          : const [],
    );
  }
}

String _firstText(
  Map<String, dynamic> json,
  List<String> keys, {
  String fallback = '',
}) {
  for (final key in keys) {
    final value = _text(json[key]);
    if (value.isNotEmpty) return value;
  }
  return fallback;
}

String _text(Object? value, {String fallback = ''}) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? fallback : text;
}

int? _asInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(_text(value));
}

double? _asDouble(Object? value) {
  if (value is num) return value.toDouble();
  return double.tryParse(_text(value));
}

bool _asBool(Object? value) {
  if (value is bool) return value;
  if (value is num) return value != 0;
  return const {'true', '1', 'yes', 'on'}.contains(_text(value).toLowerCase());
}

DateTime? _asDate(Object? value) {
  final raw = _text(value);
  return raw.isEmpty ? null : DateTime.tryParse(raw)?.toLocal();
}
