import 'dart:typed_data';

import 'package:intl/intl.dart';

import '../../../core/services/api_client.dart';
import '../models/cath_consumable_models.dart';
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

  static Future<List<CathConsumableCatalogItem>> searchConsumableCatalog({
    String? query,
    String? scan,
  }) async {
    final response = await ApiClient.get(
      '/cath-lab/consumables/catalog',
      queryParameters: {
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

  static Future<List<CathInventoryBatch>> fetchConsumableBatches(
    int catalogItemId,
  ) async {
    final response = await ApiClient.get(
      '/cath-lab/consumables/catalog/$catalogItemId/batches',
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

  static Future<List<CathCaseConsumableUsage>> fetchConsumablesForCase(
    int caseId,
  ) async {
    final response = await ApiClient.get('/cath-lab/cases/$caseId/consumables');
    final data = _successfulData(
      response,
      'Failed to load Cath Lab consumable usage',
    );
    return _mapList(data['usage'])
        .map(CathCaseConsumableUsage.fromJson)
        .where((usage) => usage.id > 0)
        .toList(growable: false);
  }

  static Future<CathCaseConsumableUsage> createConsumableUsage(
    int caseId,
    CathConsumableUsageDraft draft,
  ) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/consumables',
      body: draft.toJson(),
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
    return _mapList(
      data['templates'],
    ).map(CathReportTemplate.fromJson).toList(growable: false);
  }

  static Future<List<CathProcedureReport>> fetchReportsForCase(
    int caseId,
  ) async {
    final response = await ApiClient.get('/cath-lab/cases/$caseId/reports');
    final data = _successfulData(response, 'Failed to load Cath Lab reports');
    return _mapList(
      data['reports'],
    ).map(CathProcedureReport.fromJson).toList(growable: false);
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

  static List<Map<String, dynamic>> _mapList(Object? value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList(growable: false);
  }
}
