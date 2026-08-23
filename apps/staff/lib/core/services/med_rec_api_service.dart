import 'api_client.dart';

/// Medication reconciliation API calls (roadmap B6): start a reconciliation,
/// list a patient's reconciliations, fetch one with its items, record
/// per-item decisions, and complete.
///
/// Backend contract: `apps/backend/src/routes/clinical/medRecRoutes.js` +
/// `services/clinical/medicationReconciliationService.js`. Reconciliation ids
/// are UUID strings; item ids are integers.
class MedRecApiService {
  MedRecApiService._();

  /// Decisions the backend accepts on an item (ITEM_DECISIONS).
  static const decisions = ['continue', 'stop', 'change', 'new', 'hold'];

  /// Reconciliation types the backend accepts (REC_TYPES).
  static const recTypes = ['admission', 'transfer', 'discharge'];

  // ─── Helpers ──────────────────────────────────────────────────────────────

  static Future<Map<String, dynamic>> _get(
    String path, {
    Map<String, String>? query,
  }) async {
    final resp = await ApiClient.get(path, queryParameters: query);
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body, {
    String? idempotencyKey,
  }) async {
    final resp = await ApiClient.post(
      path,
      body: body,
      idempotencyKey: idempotencyKey,
    );
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _patch(
    String path,
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.patch(path, body: body);
    return _handle(resp);
  }

  static Map<String, dynamic> _handle(ApiResponse resp) {
    if (resp.isSuccess && resp.raw is Map) {
      final raw = resp.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        final data = raw['data'];
        if (data is Map<String, dynamic>) return data;
        if (data is List) return {'data': data};
        return raw;
      }
    }
    throw Exception(resp.failureMessage());
  }

  // ─── Calls ────────────────────────────────────────────────────────────────

  /// POST /med-rec/start — opens a reconciliation and snapshots the
  /// patient's medication sources into items. Returns the reconciliation.
  static Future<Map<String, dynamic>> startReconciliation({
    required String patientUid,
    required String recType,
    int? admissionId,
    String? encounterId,
    String? transferContext,
    String? notes,
  }) async {
    final data = await _post('/med-rec/start', {
      'patient_uid': patientUid,
      'rec_type': recType,
      'admission_id': ?admissionId,
      'encounter_id': ?encounterId,
      'transfer_context': ?transferContext,
      'notes': ?notes,
    });
    return (data['reconciliation'] as Map<String, dynamic>?) ?? data;
  }

  /// GET /med-rec/patient/:patientUid — every reconciliation for the patient
  /// (each row carries `item_count` + `undecided_count`), newest first.
  static Future<List<Map<String, dynamic>>> listForPatient(
    String patientUid, {
    String? recType,
  }) async {
    final data = await _get(
      '/med-rec/patient/$patientUid',
      query: {if (recType != null && recType.isNotEmpty) 'rec_type': recType},
    );
    return ((data['reconciliations'] as List?) ?? const [])
        .whereType<Map<String, dynamic>>()
        .toList();
  }

  /// GET /med-rec/:id — one reconciliation including its items[].
  static Future<Map<String, dynamic>> getReconciliation(String recId) async {
    final data = await _get('/med-rec/$recId');
    return (data['reconciliation'] as Map<String, dynamic>?) ?? data;
  }

  /// PATCH /med-rec/:id/items/:itemId — record a decision on one item.
  /// The service requires `reason` for stop/change/hold, and change detail
  /// (changed_* or new_instructions) for a change. Returns the updated item.
  static Future<Map<String, dynamic>> decideItem({
    required String recId,
    required int itemId,
    required String decision,
    String? reason,
    String? newInstructions,
    String? changedDose,
    String? changedRoute,
    String? changedFrequency,
    String? safetyRationale,
  }) async {
    final data = await _patch('/med-rec/$recId/items/$itemId', {
      'decision': decision,
      'reason': ?reason,
      'new_instructions': ?newInstructions,
      'changed_dose': ?changedDose,
      'changed_route': ?changedRoute,
      'changed_frequency': ?changedFrequency,
      'safety_rationale': ?safetyRationale,
    });
    return (data['item'] as Map<String, dynamic>?) ?? data;
  }

  /// POST /med-rec/:id/complete — the service refuses while items are
  /// undecided, high-alert discrepancies lack documented decisions, or the
  /// safety screen finds blockers; surface its message verbatim.
  static Future<Map<String, dynamic>> completeReconciliation(
    String recId,
  ) async {
    final data = await _post('/med-rec/$recId/complete', {});
    return (data['reconciliation'] as Map<String, dynamic>?) ?? data;
  }
}
