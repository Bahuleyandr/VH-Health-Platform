import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'api_client.dart';

/// Medical API calls: investigations, consultations, prescriptions, EMR,
/// health records, vitals, diagnosis, clinical notes, and CDS.
class MedicalApiService {
  MedicalApiService._();

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
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.post(path, body: body);
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _put(
    String path,
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.put(path, body: body);
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
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  // ─── Consultations ──────────────────────────────────────────────────────────

  /// POST /staff/medical/consultations
  static Future<Map<String, dynamic>> uploadConsultation({
    required String phone,
    required String consultationType,
    String? patientName,
    String? notes,
    String? date,
    Map<String, dynamic>? additionalData,
  }) async {
    return _post('/staff/medical/consultations', {
      'phone': phone,
      'consultationType': consultationType,
      'patientName': ?patientName,
      'notes': ?notes,
      'date': ?date,
      if (additionalData != null) ...additionalData,
    });
  }

  // ─── Investigations ──────────────────────────────────────────────────────────

  /// POST /investigations/order — doctor/admin investigation order entry.
  static Future<Map<String, dynamic>> orderInvestigation({
    required int patientId,
    required String testName,
    String type = 'LAB',
    String priority = 'NORMAL',
    String? notes,
  }) async {
    return _post('/investigations/order', {
      'patient_id': patientId,
      'test_name': testName,
      'type': type,
      'priority': priority,
      'notes': ?notes,
    });
  }

  /// POST /staff/medical/investigations
  /// When filePath is provided, uses multipart upload.
  static Future<Map<String, dynamic>> uploadInvestigation({
    required String phone,
    required String testType,
    String? result,
    String? notes,
    String? fileUrl,
    String? date,
    String? filePath,
    String? fileName,
  }) async {
    if (filePath != null) {
      final fields = <String, String>{
        'phone': phone,
        'testType': testType,
        'result': ?result,
        'notes': ?notes,
        'date': ?date,
      };
      final files = [
        await http.MultipartFile.fromPath('file', filePath, filename: fileName),
      ];
      final resp = await ApiClient.multipart(
        '/staff/medical/investigations',
        fields: fields,
        files: files,
      );
      return _handle(resp);
    }

    return _post('/staff/medical/investigations', {
      'phone': phone,
      'testType': testType,
      'result': ?result,
      'notes': ?notes,
      'fileUrl': ?fileUrl,
      'date': ?date,
    });
  }

  /// GET /investigations/status/pending — pending investigations
  static Future<Map<String, dynamic>> getPendingInvestigations() async {
    return _get('/investigations/status/pending');
  }

  /// GET /investigations/doctor/:doctor_id — investigations for a doctor
  static Future<Map<String, dynamic>> getDoctorInvestigations(
    String doctorId,
  ) async {
    return _get('/investigations/doctor/$doctorId');
  }

  /// PUT /investigations/:id/results — add results to an investigation
  static Future<Map<String, dynamic>> addInvestigationResults(
    String investigationId,
    Map<String, dynamic> results,
  ) async {
    return _put('/investigations/$investigationId/results', results);
  }

  /// PUT /investigations/:id/status — update investigation status
  static Future<Map<String, dynamic>> updateInvestigationStatus(
    String investigationId,
    String status,
  ) async {
    return _put('/investigations/$investigationId/status', {'status': status});
  }

  /// GET /investigations/list — list investigations with filters
  static Future<Map<String, dynamic>> listInvestigations({
    int page = 1,
    int limit = 20,
  }) async {
    return _get(
      '/investigations/list',
      query: {'page': page.toString(), 'limit': limit.toString()},
    );
  }

  // ─── Investigation Bookings ─────────────────────────────────────────────

  /// GET /investigations/bookings/queue
  static Future<Map<String, dynamic>> getInvestigationBookingQueue({
    String? status,
    String? collectionType,
    String? fromDate,
    String? toDate,
  }) async {
    final query = <String, String>{};
    if (status != null) query['status'] = status;
    if (collectionType != null) query['collection_type'] = collectionType;
    if (fromDate != null) query['from_date'] = fromDate;
    if (toDate != null) query['to_date'] = toDate;
    return _get('/investigations/bookings/queue', query: query);
  }

  /// POST /investigations/bookings/create — staff creates OP/IP lab booking.
  static Future<Map<String, dynamic>> createInvestigationBooking({
    required String patientPhone,
    String? patientName,
    String? customTestNames,
    String collectionType = 'walk_in',
    String? preferredDate,
    String? preferredTimeSlot,
    String? notes,
    String? slipPath,
    String? slipFileName,
  }) async {
    final fields = <String, String>{
      'patient_phone': patientPhone,
      if (patientName != null && patientName.trim().isNotEmpty)
        'patient_name': patientName.trim(),
      if (customTestNames != null && customTestNames.trim().isNotEmpty)
        'custom_test_names': customTestNames.trim(),
      'collection_type': collectionType,
      'preferred_date': ?preferredDate,
      'preferred_time_slot': ?preferredTimeSlot,
      if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
    };
    if (slipPath != null) {
      final files = [
        await http.MultipartFile.fromPath(
          'slip_photo',
          slipPath,
          filename: slipFileName,
        ),
      ];
      final resp = await ApiClient.multipart(
        '/investigations/bookings/create',
        fields: fields,
        files: files,
      );
      return _handle(resp);
    }
    return _post('/investigations/bookings/create', fields);
  }

  /// GET /investigations/bookings/:id
  static Future<Map<String, dynamic>> getInvestigationBookingDetail(int id) {
    return _get('/investigations/bookings/$id');
  }

  /// GET /investigations/bookings/sla
  static Future<Map<String, dynamic>> getInvestigationBookingSLA({
    String? fromDate,
    String? toDate,
  }) async {
    final query = <String, String>{};
    if (fromDate != null) query['from_date'] = fromDate;
    if (toDate != null) query['to_date'] = toDate;
    return _get('/investigations/bookings/sla', query: query);
  }

  /// POST /investigations/bookings/:id/confirm
  static Future<Map<String, dynamic>> confirmInvestigationBooking(
    int id,
    Map<String, dynamic> data,
  ) {
    return _post('/investigations/bookings/$id/confirm', data);
  }

  /// POST /investigations/bookings/:id/dispatch
  static Future<Map<String, dynamic>> dispatchCollector(
    int id,
    Map<String, dynamic> data,
  ) {
    return _post('/investigations/bookings/$id/dispatch', data);
  }

  /// POST /investigations/bookings/:id/collected
  static Future<Map<String, dynamic>> markSamplesCollected(
    int id, {
    String? notes,
  }) {
    return _post('/investigations/bookings/$id/collected', {
      'collection_notes': ?notes,
    });
  }

  /// POST /investigations/bookings/:id/processing
  static Future<Map<String, dynamic>> startBookingProcessing(int id) {
    return _post('/investigations/bookings/$id/processing', {});
  }

  /// POST /investigations/bookings/:id/result (multipart)
  static Future<Map<String, dynamic>> uploadBookingResult(
    int id,
    String filePath, {
    String? notes,
    String? fileName,
  }) async {
    final fields = <String, String>{'result_notes': ?notes};
    final files = [
      await http.MultipartFile.fromPath('file', filePath, filename: fileName),
    ];
    final resp = await ApiClient.multipart(
      '/investigations/bookings/$id/result',
      fields: fields,
      files: files,
    );
    return _handle(resp);
  }

  // ─── Health Records ──────────────────────────────────────────────────────

  /// GET /records/health-records/:phone — fetch patient health records by phone
  static Future<Map<String, dynamic>> getHealthRecords(String phone) async {
    return _get('/records/health-records/$phone');
  }

  /// POST /health/records — create a health record with vital signs
  static Future<Map<String, dynamic>> recordVitals({
    required int patientId,
    Map<String, dynamic>? vitalSigns,
    Map<String, dynamic>? measurements,
    String? notes,
    int? recordedBy,
  }) async {
    return _post('/health/records', {
      'patient_id': patientId,
      'record_type': 'VITALS',
      'vital_signs': ?vitalSigns,
      'measurements': ?measurements,
      'notes': ?notes,
      'recorded_by': ?recordedBy,
    });
  }

  /// GET /health/patient/:patient_id/trends — vital trends for a patient
  static Future<Map<String, dynamic>> getPatientVitalTrends(
    int patientId, {
    int? days,
    String? vitalType,
  }) async {
    return _get(
      '/health/patient/$patientId/trends',
      query: {
        if (days != null) 'days': days.toString(),
        'vital_type': ?vitalType,
      },
    );
  }

  /// GET /records/health-records/:phone — health records by phone
  static Future<Map<String, dynamic>> getHealthRecordsByPhone(
    String phone,
  ) async {
    return _get('/records/health-records/$phone');
  }

  // ─── E-Prescriptions ──────────────────────────────────────────────────────

  /// POST /prescriptions/create — create structured e-prescription
  static Future<Map<String, dynamic>> createEPrescription(
    Map<String, dynamic> data, {
    File? photo,
  }) async {
    if (photo != null) {
      final fields = <String, String>{};
      data.forEach((key, value) {
        if (value != null) {
          fields[key] = value is String ? value : jsonEncode(value);
        }
      });
      final files = [
        await http.MultipartFile.fromPath('handwritten_photo', photo.path),
      ];
      final resp = await ApiClient.multipart(
        '/prescriptions/create',
        fields: fields,
        files: files,
      );
      return _handle(resp);
    }
    return _post('/prescriptions/create', data);
  }

  /// GET /prescriptions/:id — get prescription detail
  static Future<Map<String, dynamic>> getEPrescription(int id) async {
    return _get('/prescriptions/$id');
  }

  /// POST /prescriptions/safety-check — run CDS preview. Returns
  /// `{ safe, warnings, blockers }`. Staff app calls this before create so we
  /// can drive the hard-block UX without the user losing their form state.
  static Future<Map<String, dynamic>> checkPrescriptionSafety({
    required int patientId,
    required List<Map<String, dynamic>> medications,
  }) async {
    return _post('/prescriptions/safety-check', {
      'patient_id': patientId,
      'medications': medications,
    });
  }

  // ─── MAR 5-rights (bedside barcode verification) ──────────────────────────

  /// POST /clinical/mar/verify — dry-run 5-rights check. Returns
  /// `{ ma, rights: {patient,drug,dose,route,time}, allPassed, context }`.
  static Future<Map<String, dynamic>> verify5Rights({
    required int maId,
    required String scannedPatientUid,
    required String scannedBarcode,
  }) async {
    return _post('/clinical/mar/verify', {
      'ma_id': maId,
      'scanned_patient_uid': scannedPatientUid,
      'scanned_barcode': scannedBarcode,
    });
  }

  /// POST /clinical/mar/:id/administer-with-scan — commit administration with
  /// rights audit. Throws if the backend returns 409 and no [overrideReason]
  /// was supplied; caller should prompt for one and retry.
  static Future<Map<String, dynamic>> administerWithScan({
    required int maId,
    required String scannedPatientUid,
    required String scannedBarcode,
    String? overrideReason,
  }) async {
    return _post('/clinical/mar/$maId/administer-with-scan', {
      'scanned_patient_uid': scannedPatientUid,
      'scanned_barcode': scannedBarcode,
      'override_reason': ?overrideReason,
    });
  }

  /// GET /clinical/mar/due — nurse "due meds" list within a rolling window.
  /// Returns a list of map rows with keys: id, patient_uid, patient_name,
  /// medication_name, dose, dosage, route, scheduled_time, status, bed_number,
  /// ward_id, ward_name. Tap a row to feed `id` into [MarScanScreen] as `maId`.
  static Future<List<Map<String, dynamic>>> getDueMedications({
    int? wardId,
    int pastMinutes = 120,
    int futureMinutes = 60,
  }) async {
    final query = <String, String>{
      if (wardId != null) 'ward_id': wardId.toString(),
      'past_minutes': pastMinutes.toString(),
      'future_minutes': futureMinutes.toString(),
    };
    final resp = await ApiClient.get(
      '/clinical/mar/due',
      queryParameters: query,
    );
    if (!resp.isSuccess || resp.raw is! Map) {
      throw Exception(
        resp.message ?? 'Failed to load due medications (${resp.statusCode})',
      );
    }
    final raw = resp.raw as Map<String, dynamic>;
    if (raw['success'] != true) {
      throw Exception(
        raw['message']?.toString() ?? 'Failed to load due medications',
      );
    }
    final data = raw['data'];
    if (data is List) {
      return data
          .whereType<Map>()
          .map((m) => m.cast<String, dynamic>())
          .toList();
    }
    return const [];
  }

  /// GET /prescriptions/all — list all prescriptions (admin/staff)
  static Future<List<dynamic>> getEPrescriptionsList({
    String? doctorId,
    String? fromDate,
    String? toDate,
  }) async {
    final data = await _get(
      '/prescriptions/all',
      query: {
        'doctor_id': ?doctorId,
        'from_date': ?fromDate,
        'to_date': ?toDate,
      },
    );
    return data['data'] as List? ?? [];
  }

  // ─── Medical Records / Prescriptions ─────────────────────────────────────

  /// POST /records/create — create a medical record
  static Future<Map<String, dynamic>> createPrescription({
    required int patientId,
    required String title,
    String? description,
    String? diagnosis,
    String? treatment,
    String? medications,
    int? privacyLevel,
  }) async {
    return _post('/records/create', {
      'patient_id': patientId,
      'record_type': 'PRESCRIPTION',
      'title': title,
      'description': ?description,
      'diagnosis': ?diagnosis,
      'treatment': ?treatment,
      'medications': ?medications,
      'privacy_level': ?privacyLevel,
    });
  }

  /// GET /records/doctor/:doctor_id — records created by a doctor
  static Future<Map<String, dynamic>> getDoctorRecords(String doctorId) async {
    return _get('/records/doctor/$doctorId');
  }

  /// GET /records/records — list all medical records with filters
  static Future<Map<String, dynamic>> getMedicalRecords({
    String? type,
    String? dateFrom,
    String? dateTo,
    int? patientId,
    int? doctorId,
    int page = 1,
    int limit = 20,
  }) async {
    return _get(
      '/records/records',
      query: {
        'type': ?type,
        'date_from': ?dateFrom,
        'date_to': ?dateTo,
        if (patientId != null) 'patient_id': patientId.toString(),
        if (doctorId != null) 'doctor_id': doctorId.toString(),
        'page': page.toString(),
        'limit': limit.toString(),
      },
    );
  }

  /// GET /records/patient/:patient_id — records for a specific patient
  static Future<Map<String, dynamic>> getPatientRecords(int patientId) async {
    return _get('/records/patient/$patientId');
  }

  /// POST /appointments/patient/records/upload — upload prior patient record.
  static Future<Map<String, dynamic>> uploadPatientPriorRecord({
    required String patientPhone,
    String? patientName,
    required String title,
    required String documentType,
    required String filePath,
    String? fileName,
    String? sourceHospital,
    String? recordDate,
    String? notes,
  }) async {
    final fields = <String, String>{
      'patient_phone': patientPhone,
      if (patientName != null && patientName.trim().isNotEmpty)
        'patient_name': patientName.trim(),
      'title': title,
      'document_type': documentType,
      if (sourceHospital != null && sourceHospital.trim().isNotEmpty)
        'source_hospital': sourceHospital.trim(),
      'record_date': ?recordDate,
      if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
    };
    final files = [
      await http.MultipartFile.fromPath('file', filePath, filename: fileName),
    ];
    final resp = await ApiClient.multipart(
      '/appointments/patient/records/upload',
      fields: fields,
      files: files,
    );
    return _handle(resp);
  }

  // ─── EMR: Admissions ──────────────────────────────────────────────────────

  /// POST /emr/admit — admit a patient
  static Future<Map<String, dynamic>> admitPatient(
    Map<String, dynamic> data,
  ) async {
    return _post('/emr/admit', data);
  }

  /// POST /emr/:id/discharge — discharge a patient
  static Future<Map<String, dynamic>> dischargePatient(
    int id,
    Map<String, dynamic> data,
  ) async {
    return _post('/emr/$id/discharge', data);
  }

  /// POST /emr/:id/discharge-summary/generate — auto-generate discharge summary
  static Future<Map<String, dynamic>> generateDischargeSummary(int id) async {
    return _post('/emr/$id/discharge-summary/generate', {});
  }

  /// PUT /emr/:id/discharge-summary — save/edit discharge summary draft
  static Future<Map<String, dynamic>> saveDischargeSummary(
    int id,
    Map<String, dynamic> summary,
  ) async {
    return _put('/emr/$id/discharge-summary', {'discharge_summary': summary});
  }

  /// POST /emr/:id/discharge-summary/sign — doctor signs discharge summary
  static Future<Map<String, dynamic>> signDischargeSummary(int id) async {
    return _post('/emr/$id/discharge-summary/sign', {});
  }

  /// GET /emr/admissions — list active admissions
  static Future<Map<String, dynamic>> getActiveAdmissions({
    int page = 1,
    int limit = 20,
  }) async {
    return _get('/emr/admissions', query: {'page': '$page', 'limit': '$limit'});
  }

  /// GET /emr/admission/:id — admission detail
  static Future<Map<String, dynamic>> getAdmissionDetail(int id) async {
    return _get('/emr/admission/$id');
  }

  // ─── EMR: Clinical Notes ──────────────────────────────────────────────────

  /// POST /emr/notes — create a clinical note
  static Future<Map<String, dynamic>> createClinicalNote(
    Map<String, dynamic> data,
  ) async {
    return _post('/emr/notes', data);
  }

  /// GET /emr/notes/patient/:uid — fetch notes for a patient
  static Future<Map<String, dynamic>> getPatientNotes(
    String uid, {
    String? noteType,
  }) async {
    return _get('/emr/notes/patient/$uid', query: {'note_type': ?noteType});
  }

  /// GET /emr/timeline/:uid — full clinical timeline for a patient
  static Future<Map<String, dynamic>> getPatientTimeline(String uid) async {
    return _get('/emr/timeline/$uid');
  }

  /// POST /emr/notes/:id/sign — sign a clinical note
  static Future<Map<String, dynamic>> signNote(int id) async {
    return _post('/emr/notes/$id/sign', {});
  }

  // ─── EMR: Orders ──────────────────────────────────────────────────────────

  /// POST /emr/orders — create an order (medication, investigation, nursing)
  static Future<Map<String, dynamic>> createEmrOrder(
    Map<String, dynamic> data,
  ) async {
    return _post('/emr/orders', data);
  }

  /// GET /emr/orders/patient/:uid — list orders for a patient
  static Future<Map<String, dynamic>> getPatientOrders(String uid) async {
    return _get('/emr/orders/patient/$uid');
  }

  /// PUT /emr/orders/:id/verify — verify an order
  static Future<Map<String, dynamic>> verifyOrder(int id) async {
    final resp = await ApiClient.put('/emr/orders/$id/verify', body: {});
    return _handle(resp);
  }

  /// PUT /emr/orders/:id/complete — complete an order
  static Future<Map<String, dynamic>> completeOrder(int id) async {
    final resp = await ApiClient.put('/emr/orders/$id/complete', body: {});
    return _handle(resp);
  }

  // ─── EMR: Vitals ──────────────────────────────────────────────────────────

  /// POST /emr/vitals — record EMR vitals
  static Future<Map<String, dynamic>> recordEmrVitals(
    Map<String, dynamic> data,
  ) async {
    return _post('/emr/vitals', data);
  }

  /// GET /emr/vitals/:uid/trend — vital trend data for a patient
  static Future<Map<String, dynamic>> getVitalsTrend(
    String uid,
    String vital,
  ) async {
    return _get('/emr/vitals/$uid/trend', query: {'vital': vital});
  }

  /// POST /emr/io — record intake/output entry
  static Future<Map<String, dynamic>> recordIO(
    Map<String, dynamic> data,
  ) async {
    return _post('/emr/io', data);
  }

  /// GET /emr/io/:uid/balance — I/O balance for a patient
  static Future<Map<String, dynamic>> getIOBalance(
    String uid, {
    String? date,
  }) async {
    return _get('/emr/io/$uid/balance', query: {'date': ?date});
  }

  // ─── EMR: Diagnosis ───────────────────────────────────────────────────────

  /// POST /emr/diagnosis — add a diagnosis
  static Future<Map<String, dynamic>> addDiagnosis(
    Map<String, dynamic> data,
  ) async {
    return _post('/emr/diagnosis', data);
  }

  /// GET /emr/diagnosis/patient/:uid — active problem list
  static Future<Map<String, dynamic>> getActiveProblemList(String uid) async {
    return _get('/emr/diagnosis/patient/$uid');
  }

  /// GET /emr/icd10/search — search ICD-10 codes
  static Future<Map<String, dynamic>> searchICD10(String query) async {
    return _get('/emr/icd10/search', query: {'q': query});
  }

  // ─── EMR: CDS (Clinical Decision Support) ─────────────────────────────────

  /// POST /emr/cds/check-order — run CDS checks on an order
  static Future<Map<String, dynamic>> checkOrder(
    Map<String, dynamic> orderData,
  ) async {
    return _post('/emr/cds/check-order', orderData);
  }

  /// GET /emr/cds/alerts/:uid — active CDS alerts for a patient
  static Future<Map<String, dynamic>> getActiveAlerts(String uid) async {
    return _get('/emr/cds/alerts/$uid');
  }

  // ─── Delivery Tracking ──────────────────────────────────────────────────

  /// POST /delivery/location-update — send GPS location during delivery
  static Future<void> updateDeliveryLocation({
    required String orderType,
    required int orderId,
    required double lat,
    required double lng,
    double? accuracy,
    double? speed,
    double? heading,
    int? batteryLevel,
  }) async {
    await _post('/delivery/location-update', {
      'order_type': orderType,
      'order_id': orderId,
      'lat': lat,
      'lng': lng,
      'accuracy': ?accuracy,
      'speed': ?speed,
      'heading': ?heading,
      'battery_level': ?batteryLevel,
    });
  }

  /// POST /delivery/stop-tracking — stop location sharing
  static Future<void> stopDeliveryTracking({
    required String orderType,
    required int orderId,
  }) async {
    await _post('/delivery/stop-tracking', {
      'order_type': orderType,
      'order_id': orderId,
    });
  }
}
