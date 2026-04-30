// Clinical AI API service for the staff app.
//
// Wraps the four clinical-plane endpoints exposed by the backend at
// /api/v1/clinical-ai/clinical/* (Phase 0 of the rollout plan,
// docs/CLINICAL_AI_ROLLOUT_PLAN.md):
//
//   POST   /admission-ai-draft          generate a single-module draft
//   POST   /discharge-compose           start a fresh compose run
//   GET    /discharge-compose           list recent compose runs
//   GET    /discharge-compose/:runId    fetch run + children tree
//   POST   /discharge-compose/:runId/resume  resume paused run
//   GET    /reviews                     caller's review queue
//   PATCH  /reviews/:id                 sign / edit / reject
//
// The backend's per-module reviewRoles filter is the real gate — this
// client just sends the request; if the caller's role can't review the
// module, the backend returns 403. Surface that as a clear error.
//
// Style mirrors apps/staff/lib/core/services/medical_api_service.dart:
// thin wrappers around ApiClient with envelope-unwrapping + a `_handle`
// method that throws on non-success.

import 'api_client.dart';

class ClinicalAiApiService {
  ClinicalAiApiService._();

  // Path prefix for every endpoint in this service. Lives in one place
  // so a future tenant migration off /clinical/* (e.g. to /v2/clinical/*)
  // is a one-line change.
  static const _basePath = '/api/v1/clinical-ai/clinical';

  // ---------- helpers ---------------------------------------------------

  static Future<Map<String, dynamic>> _get(
    String path, {
    Map<String, String>? query,
  }) async {
    final resp = await ApiClient.get(path, queryParameters: query);
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.post(path, body: body);
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
    throw Exception(resp.message ?? 'Clinical AI request failed (${resp.statusCode})');
  }

  // ---------- review queue + decisions ----------------------------------

  /// GET /reviews — caller's review queue (auto-filtered by role on the
  /// backend, so the caller doesn't pass their own role here).
  ///
  /// Optional filters narrow the queue:
  ///   * [decision]     'pending' | 'accepted' | 'rejected' | 'edited' | 'needs_revision'
  ///   * [moduleKey]    limit to one module (e.g. 'medication_reconciliation')
  ///   * [limit]        clamped 1..500 by the backend; default 100
  static Future<List<Map<String, dynamic>>> listMyReviews({
    String? decision,
    String? moduleKey,
    int? limit,
  }) async {
    final query = <String, String>{};
    if (decision != null && decision.isNotEmpty) query['decision'] = decision;
    if (moduleKey != null && moduleKey.isNotEmpty) query['module_key'] = moduleKey;
    if (limit != null) query['limit'] = limit.toString();
    final data = await _get('$_basePath/reviews', query: query);
    final reviews = data['reviews'];
    if (reviews is List) {
      return reviews.cast<Map<String, dynamic>>();
    }
    return const [];
  }

  /// PATCH /reviews/:id — record a decision.
  ///
  ///   * [decision]        'accepted' | 'rejected' | 'edited' | 'needs_revision' | 'deferred'
  ///   * [editedDraft]     optional — when the reviewer edited the draft before
  ///                       accepting, send the edited JSON shape here. Backend
  ///                       computes the diff vs the original for decision memory.
  ///   * [rejectionReason] required when decision == 'rejected'
  ///
  /// Returns the updated review row.
  static Future<Map<String, dynamic>> decideReview(
    int reviewId, {
    required String decision,
    Map<String, dynamic>? editedDraft,
    String? rejectionReason,
  }) async {
    final body = <String, dynamic>{'decision': decision};
    if (editedDraft != null) body['edited_draft'] = editedDraft;
    if (rejectionReason != null && rejectionReason.isNotEmpty) {
      body['rejection_reason'] = rejectionReason;
    }
    return _patch('$_basePath/reviews/$reviewId', body);
  }

  // ---------- single-module draft generation ---------------------------

  /// POST /admission-ai-draft — generate one of the ADMISSION_MODULES
  /// drafts for an admission. Returns the standard draft response shape
  /// (draft, citations, safety_flags, generation_id, review_id, etc.).
  static Future<Map<String, dynamic>> generateAdmissionDraft({
    required int admissionId,
    required String moduleKey,
  }) async {
    return _post('$_basePath/admission-ai-draft', {
      'admission_id': admissionId,
      'module_key': moduleKey,
    });
  }

  // ---------- discharge compose ----------------------------------------

  /// POST /discharge-compose — kick off a discharge package compose
  /// (orchestrates med rec + aftercare + readiness + coding).
  static Future<Map<String, dynamic>> startDischargeCompose({
    required int admissionId,
  }) async {
    return _post('$_basePath/discharge-compose', {
      'admission_id': admissionId,
    });
  }

  /// GET /discharge-compose — list recent compose runs (top-level only).
  static Future<List<Map<String, dynamic>>> listDischargeComposeRuns({
    String? status,
    int? limit,
  }) async {
    final query = <String, String>{};
    if (status != null && status.isNotEmpty) query['status'] = status;
    if (limit != null) query['limit'] = limit.toString();
    final data = await _get('$_basePath/discharge-compose', query: query);
    final runs = data['runs'];
    if (runs is List) {
      return runs.cast<Map<String, dynamic>>();
    }
    return const [];
  }

  /// GET /discharge-compose/:runId — fetch run + children tree.
  static Future<Map<String, dynamic>> getDischargeComposeRun(int runId) async {
    return _get('$_basePath/discharge-compose/$runId');
  }

  /// POST /discharge-compose/:runId/resume — resume a paused compose.
  static Future<Map<String, dynamic>> resumeDischargeCompose(int runId) async {
    return _post('$_basePath/discharge-compose/$runId/resume', {});
  }
}
