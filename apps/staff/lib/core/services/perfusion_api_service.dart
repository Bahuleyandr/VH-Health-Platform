// lib/core/services/perfusion_api_service.dart
//
// Typed wrapper for the CTVS perfusion charting endpoints
// (backend: apps/backend/src/routes/theatre/ctvsPerfusionRoutes.js,
// mounted at /api/v1/ctvs).
//
// Contract notes that shape this client:
// - Sign-off and finalize are a server-enforced two-step integrity flow.
//   POST /perfusion-records/:id/signoff upserts the review ledger
//   (perfusionist / surgeon / anesthesia); the server derives the
//   perfusionist signature from the record's perfusionist (or the acting
//   staff JWT) — the client never sends perfusionist_signed_by for itself.
//   POST /perfusion-signoffs/:id/finalize refuses with
//   PERFUSION_SIGNOFF_REVIEWS_REQUIRED until all three parties are
//   recorded. Never collapse the two calls.
// - There is no GET surface for sign-offs and no record-by-id GET:
//   reads are list-shaped (filter by ot_schedule_id / patient_uid), and
//   sign-off state is only observable from the signoff/finalize POST
//   responses.
// - Perfusion records are append-only: no update/delete endpoints exist.

import 'package:vhhealth_core/services/idempotency_key.dart';

import 'api_client.dart';

class PerfusionApiService {
  PerfusionApiService._();

  /// PUT /ctvs/overlays/:otScheduleId — upsert the CTVS case overlay
  /// (readiness metadata for the theatre case).
  static Future<Map<String, dynamic>> upsertCaseOverlay({
    required int otScheduleId,
    required Map<String, dynamic> body,
  }) async {
    final resp = await ApiClient.put(
      '/ctvs/overlays/$otScheduleId',
      body: body,
      idempotencyKey: IdempotencyKey.generate(),
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Case overlay save failed'));
    }
    return _asMap(resp.dataAsMap()['overlay']);
  }

  /// GET /ctvs/overlays?ot_schedule_id=&patient_uid=&limit=
  static Future<List<Map<String, dynamic>>> listCaseOverlays({
    int? otScheduleId,
    String? patientUid,
    int? limit,
  }) async {
    final resp = await ApiClient.get(
      '/ctvs/overlays',
      queryParameters: _listQuery(
        otScheduleId: otScheduleId,
        patientUid: patientUid,
        limit: limit,
      ),
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Case overlays failed'));
    }
    return _asMapList(resp.dataAsMap()['overlays']);
  }

  /// POST /ctvs/perfusion-records — append one perfusion record
  /// (timepoints, ACT, temperature, fluids, complications) for a case.
  static Future<Map<String, dynamic>> createPerfusionRecord(
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.post(
      '/ctvs/perfusion-records',
      body: body,
      idempotencyKey: IdempotencyKey.generate(),
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Perfusion record save failed'));
    }
    return _asMap(resp.dataAsMap()['record']);
  }

  /// GET /ctvs/perfusion-records?ot_schedule_id=&patient_uid=&limit=
  static Future<List<Map<String, dynamic>>> listPerfusionRecords({
    int? otScheduleId,
    String? patientUid,
    int? limit,
  }) async {
    final resp = await ApiClient.get(
      '/ctvs/perfusion-records',
      queryParameters: _listQuery(
        otScheduleId: otScheduleId,
        patientUid: patientUid,
        limit: limit,
      ),
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Perfusion records failed'));
    }
    return _asMapList(resp.dataAsMap()['records']);
  }

  /// POST /ctvs/perfusion-records/:id/signoff — step 1 of the integrity
  /// tail. Upserts the review ledger; the server stamps the perfusionist
  /// signature from the record/actor. Optional body keys:
  /// surgeon_reviewed_by, anesthesia_reviewed_by (staff UUIDs).
  static Future<Map<String, dynamic>> submitSignoff({
    required int perfusionRecordId,
    Map<String, dynamic> body = const {},
  }) async {
    final resp = await ApiClient.post(
      '/ctvs/perfusion-records/$perfusionRecordId/signoff',
      body: body,
      idempotencyKey: IdempotencyKey.generate(),
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Perfusion sign-off failed'));
    }
    return _asMap(resp.dataAsMap()['signoff']);
  }

  /// POST /ctvs/perfusion-signoffs/:id/finalize — step 2 of the integrity
  /// tail. Server-refused (PERFUSION_SIGNOFF_REVIEWS_REQUIRED) until the
  /// perfusionist signature and both reviews exist on the sign-off row.
  static Future<Map<String, dynamic>> finalizeSignoff({
    required int signoffId,
  }) async {
    final resp = await ApiClient.post(
      '/ctvs/perfusion-signoffs/$signoffId/finalize',
      idempotencyKey: IdempotencyKey.generate(),
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Perfusion finalize failed'));
    }
    return _asMap(resp.dataAsMap()['signoff']);
  }

  /// POST /ctvs/perfusion-records/:id/device-links — link an NL-7
  /// device-patient association (must be active for the same patient).
  static Future<Map<String, dynamic>> createDeviceLink({
    required int perfusionRecordId,
    required Map<String, dynamic> body,
  }) async {
    final resp = await ApiClient.post(
      '/ctvs/perfusion-records/$perfusionRecordId/device-links',
      body: body,
      idempotencyKey: IdempotencyKey.generate(),
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Device link save failed'));
    }
    return _asMap(resp.dataAsMap()['link']);
  }

  /// GET /ctvs/perfusion-records/:id/device-links?limit=
  static Future<List<Map<String, dynamic>>> listDeviceLinks({
    required int perfusionRecordId,
    int? limit,
  }) async {
    final resp = await ApiClient.get(
      '/ctvs/perfusion-records/$perfusionRecordId/device-links',
      queryParameters: {if (limit != null) 'limit': '$limit'},
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Device links failed'));
    }
    return _asMapList(resp.dataAsMap()['links']);
  }

  static Map<String, String> _listQuery({
    int? otScheduleId,
    String? patientUid,
    int? limit,
  }) {
    return {
      if (otScheduleId != null) 'ot_schedule_id': '$otScheduleId',
      if (patientUid != null && patientUid.trim().isNotEmpty)
        'patient_uid': patientUid.trim(),
      if (limit != null) 'limit': '$limit',
    };
  }

  static Map<String, dynamic> _asMap(dynamic value) {
    if (value is Map) return Map<String, dynamic>.from(value);
    return {};
  }

  static List<Map<String, dynamic>> _asMapList(dynamic rows) {
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList(growable: false);
  }
}
