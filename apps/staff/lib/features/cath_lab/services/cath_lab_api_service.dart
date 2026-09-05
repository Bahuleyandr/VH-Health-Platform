import 'dart:typed_data';

import 'package:intl/intl.dart';

import '../../../core/services/api_client.dart';
import '../models/cath_consumable_models.dart';
import '../models/cath_readiness_models.dart';
import '../models/cath_report_models.dart';

class CathLabCaseSummary {
  const CathLabCaseSummary({
    required this.id,
    required this.patientUid,
    required this.patientName,
    required this.requestedProcedure,
    required this.status,
    required this.urgency,
    required this.labRoom,
    required this.plannedStartAt,
    required this.readinessTotal,
    required this.readinessCleared,
    required this.procedureCount,
    required this.doseRecordCount,
    required this.activePostOrderCount,
    required this.deviceLinkCount,
    this.signedReportCount = 0,
    this.reportTatMinutes,
    this.reuseRestriction,
    this.labReadinessSummary,
  });

  final int id;
  final String patientUid;
  final String patientName;
  final String requestedProcedure;
  final String status;
  final String urgency;
  final String labRoom;
  final DateTime? plannedStartAt;
  final int readinessTotal;
  final int readinessCleared;
  final int procedureCount;
  final int doseRecordCount;
  final int activePostOrderCount;
  final int deviceLinkCount;
  final int signedReportCount;
  final int? reportTatMinutes;

  /// The patient's blood-borne reuse restriction, as `GET /cath-lab/cases/:id`
  /// projects it for the caller's role. Null when the payload did not carry
  /// one — the case LIST does not — which is a different fact from `clear`
  /// and must not be rendered as a restriction of unknown status.
  final CathReuseRestriction? reuseRestriction;

  /// The stored pre-procedure lab picture for this case, as the day list
  /// carries it. Null when the case's readiness has never been resolved — a
  /// different fact from "nothing is missing", which is why it is nullable
  /// rather than an empty summary.
  ///
  /// [readinessCleared] / [readinessTotal] beside it are counts over the EIGHT
  /// check rows and say nothing about the lab items: a case can be 8/8 and be
  /// sitting on a potassium of 6.9.
  final CathLabReadinessSummary? labReadinessSummary;

  double get readinessProgress {
    if (readinessTotal <= 0) return 0;
    return (readinessCleared / readinessTotal).clamp(0, 1);
  }

  bool get readinessComplete =>
      readinessTotal > 0 && readinessCleared >= readinessTotal;

  factory CathLabCaseSummary.fromJson(Map<String, dynamic> json) {
    return CathLabCaseSummary(
      id: _asInt(json['id']) ?? 0,
      patientUid: _text(json['patient_uid']),
      patientName: _text(json['patient_name']),
      requestedProcedure: _text(json['requested_procedure']),
      status: _text(json['status'], fallback: 'scheduled'),
      urgency: _text(json['urgency'], fallback: 'routine'),
      labRoom: _text(json['lab_room']),
      plannedStartAt: _date(json['planned_start_at']),
      readinessTotal: _asInt(json['readiness_total']) ?? 0,
      readinessCleared: _asInt(json['readiness_cleared']) ?? 0,
      procedureCount: _asInt(json['procedure_count']) ?? 0,
      doseRecordCount: _asInt(json['dose_record_count']) ?? 0,
      activePostOrderCount: _asInt(json['active_post_order_count']) ?? 0,
      deviceLinkCount: _asInt(json['device_link_count']) ?? 0,
      signedReportCount: _asInt(json['signed_report_count']) ?? 0,
      reportTatMinutes: _asInt(json['report_tat_minutes']),
      reuseRestriction: json['reuse_restriction'] is Map
          ? CathReuseRestriction.fromJson(
              Map<String, dynamic>.from(json['reuse_restriction'] as Map),
            )
          : null,
      labReadinessSummary: json['lab_readiness_summary'] is Map
          ? CathLabReadinessSummary.fromJson(
              Map<String, dynamic>.from(json['lab_readiness_summary'] as Map),
            )
          : null,
    );
  }

  static DateTime? _date(Object? value) {
    final raw = _text(value);
    if (raw.isEmpty) return null;
    return DateTime.tryParse(raw)?.toLocal();
  }

  static int? _asInt(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(_text(value));
  }

  static String _text(Object? value, {String fallback = ''}) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }
}

class CathScheduleBooking {
  const CathScheduleBooking({
    required this.linkId,
    required this.caseId,
    required this.resourceName,
    required this.patientName,
    required this.requestedProcedure,
    required this.caseStatus,
    required this.urgency,
    required this.softConflict,
    required this.conflictingEmergencyCaseIds,
    this.startsAt,
    this.endsAt,
  });

  final int linkId;
  final int caseId;
  final String resourceName;
  final String patientName;
  final String requestedProcedure;
  final String caseStatus;
  final String urgency;
  final bool softConflict;
  final List<int> conflictingEmergencyCaseIds;
  final DateTime? startsAt;
  final DateTime? endsAt;

  factory CathScheduleBooking.fromJson(Map<String, dynamic> json) {
    return CathScheduleBooking(
      linkId: CathLabCaseSummary._asInt(json['link_id']) ?? 0,
      caseId: CathLabCaseSummary._asInt(json['case_id']) ?? 0,
      resourceName: CathLabCaseSummary._text(json['resource_name']),
      patientName: CathLabCaseSummary._text(json['patient_name']),
      requestedProcedure: CathLabCaseSummary._text(json['requested_procedure']),
      caseStatus: CathLabCaseSummary._text(
        json['case_status'],
        fallback: 'scheduled',
      ),
      urgency: CathLabCaseSummary._text(json['urgency'], fallback: 'routine'),
      softConflict: json['soft_conflict'] == true,
      conflictingEmergencyCaseIds:
          json['conflicting_emergency_case_ids'] is List
          ? (json['conflicting_emergency_case_ids'] as List)
                .map((id) => CathLabCaseSummary._asInt(id))
                .whereType<int>()
                .toList()
          : const [],
      startsAt: CathLabCaseSummary._date(json['starts_at']),
      endsAt: CathLabCaseSummary._date(json['ends_at']),
    );
  }
}

class CathScheduleEmergency {
  const CathScheduleEmergency({
    required this.caseId,
    required this.status,
    required this.requestedProcedure,
    required this.patientName,
    this.startedAt,
  });

  final int caseId;
  final String status;
  final String requestedProcedure;
  final String patientName;
  final DateTime? startedAt;

  factory CathScheduleEmergency.fromJson(Map<String, dynamic> json) {
    return CathScheduleEmergency(
      caseId: CathLabCaseSummary._asInt(json['id']) ?? 0,
      status: CathLabCaseSummary._text(json['status'], fallback: 'in_progress'),
      requestedProcedure: CathLabCaseSummary._text(json['requested_procedure']),
      patientName: CathLabCaseSummary._text(json['patient_name']),
      startedAt: CathLabCaseSummary._date(
        json['actual_start_at'] ??
            json['planned_start_at'] ??
            json['created_at'],
      ),
    );
  }
}

class CathScheduleStrip {
  const CathScheduleStrip({
    required this.date,
    required this.bookings,
    required this.emergencies,
    required this.hasSoftConflict,
  });

  final String date;
  final List<CathScheduleBooking> bookings;
  final List<CathScheduleEmergency> emergencies;
  final bool hasSoftConflict;

  factory CathScheduleStrip.fromJson(Map<String, dynamic> json) {
    return CathScheduleStrip(
      date: CathLabCaseSummary._text(json['date']),
      bookings: json['bookings'] is List
          ? (json['bookings'] as List)
                .whereType<Map>()
                .map(
                  (raw) => CathScheduleBooking.fromJson(
                    Map<String, dynamic>.from(raw),
                  ),
                )
                .toList()
          : const [],
      emergencies: json['emergencies'] is List
          ? (json['emergencies'] as List)
                .whereType<Map>()
                .map(
                  (raw) => CathScheduleEmergency.fromJson(
                    Map<String, dynamic>.from(raw),
                  ),
                )
                .toList()
          : const [],
      hasSoftConflict: json['has_soft_conflict'] == true,
    );
  }
}

/// Live readiness evidence resolved from the blood-bank rails (read-only).
class CathBloodReadinessEvidence {
  const CathBloodReadinessEvidence({
    required this.bloodRequestId,
    required this.requestStatus,
    required this.crossMatchStatus,
    this.bloodGroup = '',
    this.component = '',
    this.units,
    this.crossMatchedAt,
  });

  final int bloodRequestId;
  final String requestStatus;
  final String crossMatchStatus;
  final String bloodGroup;
  final String component;
  final int? units;
  final DateTime? crossMatchedAt;

  bool get crossMatchCompatible => crossMatchStatus == 'compatible';

  factory CathBloodReadinessEvidence.fromJson(Map<String, dynamic> json) {
    return CathBloodReadinessEvidence(
      bloodRequestId: CathLabCaseSummary._asInt(json['blood_request_id']) ?? 0,
      requestStatus: CathLabCaseSummary._text(
        json['request_status'],
        fallback: 'requested',
      ),
      crossMatchStatus: CathLabCaseSummary._text(
        json['cross_match_status'],
        fallback: 'pending',
      ),
      bloodGroup: CathLabCaseSummary._text(json['blood_group']),
      component: CathLabCaseSummary._text(json['component']),
      units: CathLabCaseSummary._asInt(json['units']),
      crossMatchedAt: CathLabCaseSummary._date(json['cross_matched_at']),
    );
  }
}

/// Signed-consent readiness evidence resolved from the NL-4 e-sign rails.
class CathConsentReadinessEvidence {
  const CathConsentReadinessEvidence({
    required this.consentId,
    required this.consentType,
    required this.artifactPath,
    this.capturedAt,
  });

  final int consentId;
  final String consentType;
  final String artifactPath;
  final DateTime? capturedAt;

  factory CathConsentReadinessEvidence.fromJson(Map<String, dynamic> json) {
    return CathConsentReadinessEvidence(
      consentId: CathLabCaseSummary._asInt(json['consent_id']) ?? 0,
      consentType: CathLabCaseSummary._text(json['consent_type']),
      artifactPath: CathLabCaseSummary._text(json['artifact_path']),
      capturedAt: CathLabCaseSummary._date(json['captured_at']),
    );
  }
}

/// An owner-published, deployed order set mapped to a workbench slot.
class CathOrderSetSlot {
  const CathOrderSetSlot({
    required this.orderSetId,
    required this.title,
    this.version = 1,
    this.itemCount = 0,
  });

  final int orderSetId;
  final String title;
  final int version;
  final int itemCount;

  factory CathOrderSetSlot.fromJson(Map<String, dynamic> json) {
    return CathOrderSetSlot(
      orderSetId: CathLabCaseSummary._asInt(json['order_set_id']) ?? 0,
      title: CathLabCaseSummary._text(json['title']),
      version: CathLabCaseSummary._asInt(json['version']) ?? 1,
      itemCount: CathLabCaseSummary._asInt(json['item_count']) ?? 0,
    );
  }
}

/// Quick-wins read model for one cath case: live readiness evidence plus the
/// owner-mapped order-set slots. Everything here is nullable by design — an
/// unmapped tenant or absent source rows keep the workbench exactly as today.
class CathCaseQuickWins {
  const CathCaseQuickWins({
    required this.caseId,
    this.bloodEvidence,
    this.consentEvidence,
    this.preCathOrderSet,
    this.postCathOrderSet,
  });

  final int caseId;
  final CathBloodReadinessEvidence? bloodEvidence;
  final CathConsentReadinessEvidence? consentEvidence;
  final CathOrderSetSlot? preCathOrderSet;
  final CathOrderSetSlot? postCathOrderSet;

  factory CathCaseQuickWins.fromJson(Map<String, dynamic> json) {
    final readiness = json['readiness_evidence'];
    final readinessMap = readiness is Map
        ? Map<String, dynamic>.from(readiness)
        : const <String, dynamic>{};
    final orderSets = json['order_sets'];
    final orderSetsMap = orderSets is Map
        ? Map<String, dynamic>.from(orderSets)
        : const <String, dynamic>{};
    return CathCaseQuickWins(
      caseId: CathLabCaseSummary._asInt(json['case_id']) ?? 0,
      bloodEvidence: _evidence(
        readinessMap['blood_bank'],
        CathBloodReadinessEvidence.fromJson,
      ),
      consentEvidence: _evidence(
        readinessMap['consent'],
        CathConsentReadinessEvidence.fromJson,
      ),
      preCathOrderSet: _evidence(
        orderSetsMap['pre_cath'],
        CathOrderSetSlot.fromJson,
      ),
      postCathOrderSet: _evidence(
        orderSetsMap['post_cath'],
        CathOrderSetSlot.fromJson,
      ),
    );
  }

  static T? _evidence<T>(Object? raw, T Function(Map<String, dynamic>) parse) {
    if (raw is! Map) return null;
    return parse(Map<String, dynamic>.from(raw));
  }
}

class CathInventoryReconciliation {
  const CathInventoryReconciliation({
    required this.caseId,
    required this.usageId,
    required this.patientUid,
    required this.itemName,
    required this.catalogItemId,
    required this.inventoryItemId,
    required this.inventoryBatchId,
    required this.batchNumber,
    required this.documentedQuantity,
    required this.decrementedQuantity,
    required this.remainingQuantity,
    required this.inventoryDecrementStatus,
    required this.inventoryWarning,
    required this.taskId,
    required this.taskStatus,
    required this.workflowSlaInstanceId,
    required this.slaStatus,
    required this.dueAt,
    required this.actionable,
  });

  final String caseId;
  final String usageId;
  final String patientUid;
  final String itemName;
  final String catalogItemId;
  final String inventoryItemId;
  final String inventoryBatchId;
  final String batchNumber;
  final double documentedQuantity;
  final double decrementedQuantity;
  final double remainingQuantity;
  final String inventoryDecrementStatus;
  final String inventoryWarning;
  final String taskId;
  final String taskStatus;
  final String workflowSlaInstanceId;
  final String slaStatus;
  final DateTime? dueAt;
  final bool actionable;

  bool get isCompleted =>
      inventoryDecrementStatus.trim().toLowerCase() == 'decremented' &&
      taskStatus.trim().toLowerCase() == 'completed' &&
      slaStatus.trim().toLowerCase() == 'completed' &&
      !actionable;

  bool matchesTarget({required String caseId, required String usageId}) =>
      this.caseId == caseId && this.usageId == usageId;

  factory CathInventoryReconciliation.fromJson(Map<String, dynamic> json) {
    final task = _map(json['task']);
    final sla = _map(json['workflow_sla'] ?? json['sla']);
    return CathInventoryReconciliation(
      caseId: _string(json['case_id']),
      usageId: _string(
        json['usage_id'] ??
            json['consumable_usage_id'] ??
            json['cath_consumable_usage_id'],
      ),
      patientUid: _string(json['patient_uid']),
      itemName: _string(json['item_name'] ?? json['catalog_item_name']),
      catalogItemId: _string(json['catalog_item_id'] ?? json['item_id']),
      inventoryItemId: _string(json['inventory_item_id']),
      inventoryBatchId: _string(json['inventory_batch_id']),
      batchNumber: _string(json['batch_number'] ?? json['batch_no']),
      documentedQuantity: _decimal(json['documented_quantity']),
      decrementedQuantity: _decimal(json['decremented_quantity']),
      remainingQuantity: _decimal(json['remaining_quantity']),
      inventoryDecrementStatus: _string(
        json['inventory_decrement_status'],
        fallback: 'unknown',
      ),
      inventoryWarning: _string(json['inventory_warning']),
      taskId: _string(json['task_id'] ?? task['id']),
      taskStatus: _string(
        json['task_status'] ?? task['status'],
        fallback: 'unknown',
      ),
      workflowSlaInstanceId: _string(
        json['workflow_sla_instance_id'] ?? sla['id'],
      ),
      slaStatus: _string(
        json['sla_status'] ?? sla['status'],
        fallback: 'unknown',
      ),
      dueAt: _date(json['due_at'] ?? sla['due_at']),
      actionable: _boolean(json['actionable']),
    );
  }

  static Map<String, dynamic> _map(Object? value) => value is Map
      ? Map<String, dynamic>.from(value)
      : const <String, dynamic>{};

  static String _string(Object? value, {String fallback = ''}) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }

  static double _decimal(Object? value) {
    if (value is num) return value.toDouble();
    return double.tryParse(_string(value)) ?? 0;
  }

  static DateTime? _date(Object? value) {
    final text = _string(value);
    return text.isEmpty ? null : DateTime.tryParse(text)?.toLocal();
  }

  static bool _boolean(Object? value) {
    if (value is bool) return value;
    if (value is num) return value != 0;
    return const {
      'true',
      '1',
      'yes',
      'on',
    }.contains(_string(value).toLowerCase());
  }
}

class CathInventoryReconciliationResult {
  const CathInventoryReconciliationResult({
    required this.outcome,
    required this.reconciliation,
  });

  final String outcome;
  final CathInventoryReconciliation reconciliation;
}

class CathLabApiService {
  CathLabApiService._();

  static Future<CathScheduleStrip> fetchScheduleStrip(DateTime date) async {
    final response = await ApiClient.get(
      '/cath-lab/schedule',
      queryParameters: {'date': DateFormat('yyyy-MM-dd').format(date)},
    );
    if (!response.isSuccess) {
      throw Exception(
        response.failureMessage('Failed to load Cath Lab room schedule'),
      );
    }
    return CathScheduleStrip.fromJson(response.dataAsMap());
  }

  static Future<List<CathLabCaseSummary>> fetchCasesForDate(
    DateTime date,
  ) async {
    final response = await ApiClient.get(
      '/cath-lab/cases',
      queryParameters: {
        'date': DateFormat('yyyy-MM-dd').format(date),
        'limit': '100',
      },
    );
    if (!response.isSuccess) {
      throw Exception(response.failureMessage('Failed to load Cath Lab cases'));
    }

    final data = response.dataAsMap();
    final rawCases = data['cases'];
    if (rawCases is! List) return const [];
    return rawCases
        .whereType<Map>()
        .map(
          (raw) => CathLabCaseSummary.fromJson(Map<String, dynamic>.from(raw)),
        )
        .toList();
  }

  /// GET /cath-lab/consumables/catalog.
  ///
  /// The read is case-scoped: `cathLabRoutes.js` guards it with
  /// `cathCaseQueryGuard('case_id')` and the service pins the facility from
  /// that case, so [caseId] is required — without it the call is a hard
  /// failure, not an unfiltered search. Pass the ACTIVE case, never a
  /// remembered one: the facility the operator is allowed to see comes from it.
  static Future<List<CathConsumableCatalogItem>> searchConsumableCatalog({
    required int caseId,
    String? query,
    String? scan,
  }) async {
    final response = await ApiClient.get(
      '/cath-lab/consumables/catalog',
      queryParameters: {
        'case_id': '$caseId',
        if (query != null && query.trim().isNotEmpty) 'q': query.trim(),
        if (scan != null && scan.trim().isNotEmpty) 'scan': scan.trim(),
      },
    );
    final data = _successfulData(
      response,
      'Failed to search Cath Lab consumables',
    );
    return _mapList(data['items'])
        .map(CathConsumableCatalogItem.fromJson)
        .where((item) => item.id > 0 && item.itemName.isNotEmpty)
        .toList(growable: false);
  }

  /// GET /cath-lab/consumables/catalog/:id/batches.
  ///
  /// Case-scoped for the same reason as [searchConsumableCatalog]: the batch
  /// list is facility-pinned through the case, so [caseId] is required.
  static Future<List<CathInventoryBatch>> fetchConsumableBatches(
    int catalogItemId, {
    required int caseId,
  }) async {
    final response = await ApiClient.get(
      '/cath-lab/consumables/catalog/$catalogItemId/batches',
      queryParameters: {'case_id': '$caseId'},
    );
    final data = _successfulData(
      response,
      'Failed to load Cath Lab consumable batches',
    );
    return _mapList(data['batches'])
        .map(CathInventoryBatch.fromJson)
        .where((batch) => batch.id > 0)
        .toList(growable: false);
  }

  /// POST /cath-lab/cases/:id/consumables.
  ///
  /// Mounted with `requireIdempotencyKey({ required: true, scope:
  /// 'cath_consumable_usage' })`, so [idempotencyKey] is required — without it
  /// the call is a hard 400. Hold one key for the life of a capture attempt so
  /// a retry replays instead of decrementing inventory twice.
  static Future<CathCaseConsumableUsage> createConsumableUsage(
    int caseId,
    CathConsumableUsageDraft draft, {
    required String idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/consumables',
      body: draft.toJson(),
      idempotencyKey: idempotencyKey,
    );
    final data = _successfulData(
      response,
      'Failed to record Cath Lab consumable usage',
    );
    final raw = data['usage'];
    if (raw is! Map) {
      throw Exception('Cath Lab consumable usage response was malformed');
    }
    return CathCaseConsumableUsage.fromJson(Map<String, dynamic>.from(raw));
  }

  /// GET /cath-lab/cases/:id/consumables — the case's usage rows plus the
  /// case-level reuse facts the capture sheet and the post-use buttons need:
  /// the patient's blood-borne restriction and the categories this tenant
  /// reprocesses. This is the only read of the route; a usage-only variant
  /// would drop exactly the decorations the reuse UI is built on.
  ///
  /// Roles outside the clinical-staff set get `reuse_restriction` with empty
  /// `reasons`/`markers` and the same `status`, so the strip still renders the
  /// restriction without the clinical detail behind it.
  static Future<CathCaseConsumablesPayload> fetchCaseConsumablesWithReuse(
    int caseId,
  ) async {
    final response = await ApiClient.get('/cath-lab/cases/$caseId/consumables');
    final data = _successfulData(
      response,
      'Failed to load Cath Lab consumable usage',
    );
    final restrictionRaw = data['reuse_restriction'];
    final reprocessingRaw = data['reprocessing'];
    final categories =
        reprocessingRaw is Map &&
            reprocessingRaw['reprocessable_categories'] is List
        ? (reprocessingRaw['reprocessable_categories'] as List)
              .map((entry) => entry.toString())
              .toSet()
        : <String>{};
    return CathCaseConsumablesPayload(
      usage: _mapList(data['usage'])
          .map(CathCaseConsumableUsage.fromJson)
          .where((usage) => usage.id > 0)
          .toList(growable: false),
      restriction: CathReuseRestriction.fromJson(
        restrictionRaw is Map
            ? Map<String, dynamic>.from(restrictionRaw)
            : const <String, dynamic>{},
      ),
      reprocessableCategories: categories,
    );
  }

  /// GET /cath-lab/devices/lookup?case_id=&tag= — device state for the capture
  /// sheet. Case-pinned like the catalogue reads, so a device belonging to
  /// another facility comes back as a 404 rather than being described.
  static Future<CathDeviceLookup> lookupReusableDevice(
    int caseId,
    String tag,
  ) async {
    final response = await ApiClient.get(
      '/cath-lab/devices/lookup',
      queryParameters: {'case_id': '$caseId', 'tag': tag.trim().toUpperCase()},
    );
    final data = _successfulData(response, 'Device not found');
    return CathDeviceLookup.fromJson(data);
  }

  /// POST /cath-lab/cases/:id/consumables/:usageId/post-use.
  ///
  /// Mounted with `requireIdempotencyKey({ required: true, scope:
  /// 'cath_consumable_post_use' })`: without a key the call is a hard 400, and
  /// with a stable one a retry replays the recorded result instead of minting
  /// a second batch of CSSD devices.
  static Future<CathPostUseResult> recordPostUse(
    int caseId,
    int usageId,
    CathPostUseDraft draft, {
    required String idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/consumables/$usageId/post-use',
      body: draft.toJson(),
      idempotencyKey: idempotencyKey,
    );
    final data = _successfulData(response, 'Failed to record post-use');
    return CathPostUseResult.fromJson(data);
  }

  static Future<CathInventoryReconciliation> fetchInventoryReconciliation(
    String caseId,
    String usageId,
  ) async {
    _requireCanonicalPositiveBigInt(caseId, 'caseId');
    _requireCanonicalPositiveBigInt(usageId, 'usageId');
    final response = await ApiClient.get(
      '/cath-lab/cases/$caseId/consumables/$usageId/inventory-reconcile',
    );
    final data = _successfulData(
      response,
      'Failed to load Cath Lab inventory reconciliation',
    );
    return _inventoryReconciliationFromData(data);
  }

  static Future<CathInventoryReconciliationResult> reconcileConsumableInventory(
    String caseId,
    String usageId, {
    required String idempotencyKey,
  }) async {
    _requireCanonicalPositiveBigInt(caseId, 'caseId');
    _requireCanonicalPositiveBigInt(usageId, 'usageId');
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/consumables/$usageId/inventory-reconcile',
      idempotencyKey: idempotencyKey,
    );
    final data = _successfulData(
      response,
      'Failed to reconcile Cath Lab inventory',
    );
    final outcome = data['outcome']?.toString().trim().toLowerCase() ?? '';
    if (outcome != 'completed' && outcome != 'still_insufficient') {
      throw Exception(
        'Cath Lab inventory reconciliation outcome was malformed',
      );
    }
    return CathInventoryReconciliationResult(
      outcome: outcome,
      reconciliation: _inventoryReconciliationFromData(data),
    );
  }

  static Future<CathCaseQuickWins> fetchCaseQuickWins(int caseId) async {
    final response = await ApiClient.get('/cath-lab/cases/$caseId/quick-wins');
    final data = _successfulData(
      response,
      'Failed to load Cath Lab quick wins',
    );
    final raw = data['quick_wins'];
    if (raw is! Map) {
      throw Exception('Cath Lab quick-wins response was malformed');
    }
    return CathCaseQuickWins.fromJson(Map<String, dynamic>.from(raw));
  }

  static Future<void> refreshReadinessEvidence(int caseId) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/readiness/evidence/refresh',
      body: const {},
    );
    if (!response.isSuccess) {
      throw Exception(
        response.failureMessage(
          'Failed to refresh Cath Lab readiness evidence',
        ),
      );
    }
  }

  static Future<void> applyOrderSetSlot(int caseId, String slot) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/order-sets/$slot/apply',
      body: const {},
    );
    if (!response.isSuccess) {
      throw Exception(
        response.failureMessage('Failed to apply Cath Lab order set'),
      );
    }
  }

  static Future<List<CathReportTemplate>> fetchReportTemplates({
    String? reportType,
  }) async {
    final response = await ApiClient.get(
      '/cath-lab/report-templates',
      queryParameters: {
        if (reportType != null && reportType.trim().isNotEmpty)
          'report_type': reportType.trim(),
      },
    );
    final data = _successfulData(
      response,
      'Failed to load Cath Lab report templates',
    );
    return _mapList(data['templates'])
        .map(CathReportTemplate.fromJson)
        .toList(growable: false);
  }

  static Future<List<CathProcedureReport>> fetchReportsForCase(
    int caseId,
  ) async {
    final response = await ApiClient.get('/cath-lab/cases/$caseId/reports');
    final data = _successfulData(response, 'Failed to load Cath Lab reports');
    return _mapList(data['reports'])
        .map(CathProcedureReport.fromJson)
        .toList(growable: false);
  }

  static Future<CathProcedureReport> fetchReport(int reportId) async {
    final response = await ApiClient.get('/cath-lab/reports/$reportId');
    return _reportFromResponse(response, 'Failed to load Cath Lab report');
  }

  static Future<CathProcedureReport> createReport(
    int caseId,
    CathReportDraft draft,
  ) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/reports',
      body: draft.toJson(),
    );
    return _reportFromResponse(response, 'Failed to create Cath Lab report');
  }

  static Future<CathProcedureReport> updateReport(
    int reportId,
    CathReportDraft draft,
  ) async {
    final response = await ApiClient.patch(
      '/cath-lab/reports/$reportId',
      body: draft.toJson(),
    );
    return _reportFromResponse(response, 'Failed to update Cath Lab report');
  }

  static Future<CathProcedureReport> markReportPreliminary(int reportId) async {
    final response = await ApiClient.post(
      '/cath-lab/reports/$reportId/preliminary',
      body: const {},
    );
    return _reportFromResponse(
      response,
      'Failed to mark Cath Lab report preliminary',
    );
  }

  static Future<CathProcedureReport> signReport(int reportId) async {
    final response = await ApiClient.post(
      '/cath-lab/reports/$reportId/sign',
      body: const {},
    );
    return _reportFromResponse(response, 'Failed to sign Cath Lab report');
  }

  static Future<CathReportAddendum> addReportAddendum(
    int reportId,
    CathReportAddendumDraft draft,
  ) async {
    final response = await ApiClient.post(
      '/cath-lab/reports/$reportId/addenda',
      body: draft.toJson(),
    );
    final data = _successfulData(
      response,
      'Failed to add Cath Lab report addendum',
    );
    final raw = data['addendum'];
    if (raw is! Map) {
      throw Exception('Cath Lab addendum response was malformed');
    }
    return CathReportAddendum.fromJson(Map<String, dynamic>.from(raw));
  }

  static Future<CathViewerLink> fetchViewerLink(int caseId) async {
    final response = await ApiClient.get('/cath-lab/cases/$caseId/viewer-link');
    final data = _successfulData(
      response,
      'Failed to resolve Cath Lab viewer link',
    );
    return CathViewerLink.fromJson(data);
  }

  static Future<Uint8List> downloadReportPdf(int reportId) async {
    final response = await ApiClient.getBytes(
      '/cath-lab/reports/$reportId/pdf',
      timeout: const Duration(seconds: 30),
    );
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.bodyBytes;
    }
    final parsed = ApiResponse.parse(response.statusCode, response.body);
    throw Exception(
      parsed.failureMessage('Cath Lab report PDF download failed'),
    );
  }

  /// GET `/cath-lab/cases/:id` — the eight readiness checks, the start gate
  /// and the lab-readiness block, in one read.
  ///
  /// The route answers `{ case: {...} }`, so the case object is unwrapped
  /// here; the fallback to `data` keeps a future flattening of that envelope
  /// from blanking the checklist.
  static Future<CathCaseReadiness> fetchCaseReadiness(int caseId) async {
    final response = await ApiClient.get('/cath-lab/cases/$caseId');
    final data = _successfulData(response, 'Failed to load Cath Lab case');
    final raw = data['case'] is Map
        ? Map<String, dynamic>.from(data['case'] as Map)
        : data;
    return CathCaseReadiness.fromJson(raw);
  }

  /// POST `/cath-lab/cases/:id/readiness` — the human status control over one
  /// check. The labs check is auto-managed, so a human status set here may be
  /// flipped back by the next refresh; that is the intended precedence.
  static Future<void> updateReadinessCheck(
    int caseId, {
    required String checkType,
    required String status,
    String? notes,
  }) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/readiness',
      body: {
        'check_type': checkType,
        'status': status,
        if ((notes ?? '').isNotEmpty) 'notes': notes,
      },
    );
    if (!response.isSuccess) {
      throw Exception(response.failureMessage('Failed to update readiness'));
    }
  }

  /// POST `.../readiness/labs/order-missing` — 201 with
  /// `{ created, skipped, readiness }`. The key is REQUIRED by the route
  /// (scope `cath_lab_readiness_order`): a double-tap without a stable key
  /// would raise two sets of orders.
  static Future<CathLabReadiness> orderMissingLabs(
    int caseId, {
    required String idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/readiness/labs/order-missing',
      body: const {},
      idempotencyKey: idempotencyKey,
    );
    final data = _successfulData(response, 'Failed to order missing labs');
    return _readinessFrom(data['readiness']);
  }

  /// POST `.../readiness/labs/:item/external-result` — 201 with
  /// `{ lab_result_id, item, readiness }`. The only route that mints an
  /// external-origin lab result, and the key (scope
  /// `cath_lab_readiness_external`) is what stops a retry recording the
  /// outside value twice.
  static Future<CathLabReadiness> recordExternalLabResult(
    int caseId,
    CathExternalResultDraft draft, {
    required String idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/readiness/labs/${draft.item}/external-result',
      body: draft.toJson(),
      idempotencyKey: idempotencyKey,
    );
    final data = _successfulData(response, 'Failed to record outside result');
    return _readinessFrom(data['readiness']);
  }

  /// POST `.../readiness/labs/:item/waive` — answers the refreshed readiness
  /// block itself, not a wrapper.
  ///
  /// A key is REQUIRED here too (scope `cath_lab_readiness_waive`): a waiver
  /// is an append-only clinical decision, and a double-tap without one records
  /// the same override twice under two timestamps.
  static Future<CathLabReadiness> waiveLabItem(
    int caseId,
    String item, {
    required String reason,
    required String idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/readiness/labs/$item/waive',
      body: {'reason': reason},
      idempotencyKey: idempotencyKey,
    );
    final data = _successfulData(response, 'Failed to waive lab item');
    return CathLabReadiness.fromJson(data);
  }

  /// POST `.../readiness/labs/:item/unwaive` — withdraws a waiver and answers
  /// the refreshed readiness block itself, exactly as waive does.
  ///
  /// A key is REQUIRED, under its OWN scope (`cath_lab_readiness_unwaive`).
  /// Sharing the waive scope would make a lift under a key the waive already
  /// used replay the waive's recorded response instead of running — the waiver
  /// would look removed and still be there.
  static Future<CathLabReadiness> unwaiveLabItem(
    int caseId,
    String item, {
    required String idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/readiness/labs/$item/unwaive',
      body: const {},
      idempotencyKey: idempotencyKey,
    );
    final data = _successfulData(response, 'Failed to remove the waiver');
    return CathLabReadiness.fromJson(data);
  }

  static CathLabReadiness _readinessFrom(Object? raw) {
    if (raw is! Map) {
      throw Exception('Cath Lab readiness response was malformed');
    }
    return CathLabReadiness.fromJson(Map<String, dynamic>.from(raw));
  }

  static Map<String, dynamic> _successfulData(
    ApiResponse response,
    String fallback,
  ) {
    if (!response.isSuccess) {
      throw Exception(response.failureMessage(fallback));
    }
    return response.dataAsMap();
  }

  static CathProcedureReport _reportFromResponse(
    ApiResponse response,
    String fallback,
  ) {
    final data = _successfulData(response, fallback);
    final raw = data['report'];
    if (raw is! Map) throw Exception('Cath Lab report response was malformed');
    return CathProcedureReport.fromJson(Map<String, dynamic>.from(raw));
  }

  static CathInventoryReconciliation _inventoryReconciliationFromData(
    Map<String, dynamic> data,
  ) {
    final raw = data['reconciliation'];
    if (raw is! Map) {
      throw Exception(
        'Cath Lab inventory reconciliation response was malformed',
      );
    }
    return CathInventoryReconciliation.fromJson(Map<String, dynamic>.from(raw));
  }

  static List<Map<String, dynamic>> _mapList(Object? value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList(growable: false);
  }
}

const _maximumSignedBigIntIdentifier = '9223372036854775807';

void _requireCanonicalPositiveBigInt(String value, String name) {
  final valid =
      RegExp(r'^[1-9][0-9]*$').hasMatch(value) &&
      value.length <= _maximumSignedBigIntIdentifier.length &&
      (value.length < _maximumSignedBigIntIdentifier.length ||
          value.compareTo(_maximumSignedBigIntIdentifier) <= 0);
  if (!valid) {
    throw ArgumentError.value(value, name, 'must be a positive signed BIGINT');
  }
}
