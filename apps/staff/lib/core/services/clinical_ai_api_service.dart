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
  //
  // NOTE: Do NOT include `/api/v1` here — `ApiConfig.baseUrl` already
  // ends in `/api/v1`, and `VHHttpClient._buildUri` does a straight
  // string concat (`baseUrl + path`). The prefix used to be
  // `/api/v1/clinical-ai/clinical`, which silently double-prefixed every
  // call to `…/api/v1/api/v1/clinical-ai/clinical/*` and 404'd every
  // clinical-AI feature in the staff app.
  static const _basePath = '/clinical-ai/clinical';

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
    throw Exception(
      resp.message ?? 'Clinical AI request failed (${resp.statusCode})',
    );
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
    if (moduleKey != null && moduleKey.isNotEmpty)
      query['module_key'] = moduleKey;
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
    return _post('$_basePath/discharge-compose', {'admission_id': admissionId});
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

  // ---------- voice notes (clinical-plane bridge) ----------------------
  //
  // These bridge `voiceSoapService` (Phase M3 backend) to the multi-agent
  // review pipeline. Audio capture is platform-specific (record + permission
  // flow); this client only wraps the list + generate-SOAP endpoints. The
  // `transcribe` upload is multipart and is invoked by a recording UI in a
  // separate ticket.

  /// GET /voice-note/my — list this clinician's recent voice notes
  /// (tenant-scoped). Routed through the *non-clinical* legacy path
  /// `/api/v1/clinical/voice-note/my` because voice-note endpoints predate
  /// the Phase 0 control/clinical split.
  static Future<List<Map<String, dynamic>>> listMyVoiceNotes({
    int? limit,
  }) async {
    final query = <String, String>{};
    if (limit != null) query['limit'] = limit.toString();
    // baseUrl already ends in `/api/v1`; do NOT re-prefix.
    final resp = await ApiClient.get(
      '/clinical/voice-note/my',
      queryParameters: query,
    );
    final data = _handle(resp);
    final notes = data['notes'] ?? data['data'];
    if (notes is List) return notes.cast<Map<String, dynamic>>();
    return const [];
  }

  /// POST /voice-note/:id/generate-soap — convert a completed transcript
  /// into a SOAP draft. Returns the standard draft response shape (draft,
  /// citations, safety_flags, generation_id, review_id). The draft enters
  /// the caller's review queue keyed by module_key 'soap_from_dictation'.
  static Future<Map<String, dynamic>> generateSoapFromVoiceNote(
    int voiceNoteId,
  ) async {
    // baseUrl already ends in `/api/v1`; do NOT re-prefix.
    final resp = await ApiClient.post(
      '/clinical/voice-note/$voiceNoteId/generate-soap',
      body: const {},
    );
    return _handle(resp);
  }

  // ---------- patient-facing explainers (clinical plane) ---------------
  //
  // These mirror the 5 admin-plane endpoints in
  // apps/backend/src/routes/admin/clinicalAi/patientExplainersRoutes.js
  // but live on the clinical plane (requireClinicalAiUse — clinical
  // roles + ADMIN/SUPER_ADMIN) so doctors can drive AI Assist from
  // EMR / clinical_notes_screen without an admin-plane elevation.
  //
  // Each returns the standard explainer envelope:
  //   {
  //     module_key, generation_id, draft: { explanation_summary,
  //       key_points, next_steps, when_to_seek_help, source_citations,
  //       safety_flags, fallback_used? },
  //     safety_flags, source_citations, used_ai, provider, status,
  //     review_status, requires_signoff, decision_support_only
  //   }
  //
  // The draft enters clinical_ai_reviews with decision='pending'. Use
  // decideReview(reviewId, ...) to sign / edit / reject.

  /// POST /lab-patient-explanations — explain a single lab result for the
  /// patient. Loads the investigation row server-side, so the caller
  /// only passes the integer id.
  static Future<Map<String, dynamic>> explainLabResult({
    required int investigationId,
    String language = 'en',
  }) async {
    return _post('$_basePath/lab-patient-explanations', {
      'investigation_id': investigationId,
      'language': language,
    });
  }

  /// POST /radiology-patient-explanations — explain a radiology report
  /// for the patient. Loads the radiology_orders row server-side.
  static Future<Map<String, dynamic>> explainRadiologyReport({
    required int radiologyOrderId,
    String language = 'en',
  }) async {
    return _post('$_basePath/radiology-patient-explanations', {
      'radiology_order_id': radiologyOrderId,
      'language': language,
    });
  }

  /// POST /patient-report-explanations — generic free-text report
  /// explainer. Used by the AI Assist drawer on clinical_notes_screen
  /// when the doctor wants to translate a SOAP note (or any clinical
  /// document) into a patient-facing plain-language version.
  ///
  ///  * [reportType] 'consultation' | 'discharge' | 'procedure' |
  ///                 'second_opinion' | 'referral' | 'operative_note'
  ///                 | 'case_summary' | 'soap'
  ///  * [reportText] the document body — minimum 30 characters.
  ///  * [patientUid] optional — links the draft to a patient record
  ///                 (lets the patient app surface it after sign-off).
  ///  * [admissionId] optional — links the draft to an admission.
  static Future<Map<String, dynamic>> explainPatientReport({
    required String reportType,
    required String reportText,
    String? patientUid,
    int? admissionId,
    String language = 'en',
  }) async {
    final body = <String, dynamic>{
      'report_type': reportType,
      'report_text': reportText,
      'language': language,
    };
    if (patientUid != null && patientUid.isNotEmpty)
      body['patient_uid'] = patientUid;
    if (admissionId != null) body['admission_id'] = admissionId;
    return _post('$_basePath/patient-report-explanations', body);
  }

  /// POST /prescription-patient-explanations — explain a prescription
  /// regimen for the patient (medication / dosage / duration / safety
  /// red-flags). Loads the prescriptions row server-side.
  static Future<Map<String, dynamic>> explainPrescription({
    required int prescriptionId,
    String language = 'en',
  }) async {
    return _post('$_basePath/prescription-patient-explanations', {
      'prescription_id': prescriptionId,
      'language': language,
    });
  }

  /// POST /invoice-patient-explanations — explain a billing invoice
  /// for the patient. Loads the invoices row server-side.
  static Future<Map<String, dynamic>> explainInvoice({
    required int invoiceId,
    String language = 'en',
  }) async {
    return _post('$_basePath/invoice-patient-explanations', {
      'invoice_id': invoiceId,
      'language': language,
    });
  }
}
