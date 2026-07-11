import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';

import '../models/composition_alternatives.dart';
import 'api_client.dart';
import 'clinical_platform_api_service.dart';
import 'order_payloads.dart';

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
      ...?additionalData,
    });
  }

  // ─── Investigations ──────────────────────────────────────────────────────────

  /// POST /investigations/order — doctor/admin investigation order entry.
  static Future<Map<String, dynamic>> orderInvestigation({
    required int patientId,
    required String testName,
    int? appointmentId,
    String type = 'LAB',
    String priority = 'NORMAL',
    String? notes,
  }) async {
    return _post('/investigations/order', {
      'patient_id': patientId,
      'appointment_id': ?appointmentId,
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
        await ApiClient.multipartFileFromPath(
          'file',
          filePath,
          filename: fileName,
        ),
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

  /// GET /investigations/patient/:patient_id — investigations for one patient.
  static Future<Map<String, dynamic>> getPatientInvestigations(
    String patientId, {
    String? status,
  }) async {
    final query = <String, String>{};
    if (status != null && status.trim().isNotEmpty) {
      query['status'] = status.trim();
    }
    return _get('/investigations/patient/$patientId', query: query);
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
        await ApiClient.multipartFileFromPath(
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
      await ApiClient.multipartFileFromPath(
        'file',
        filePath,
        filename: fileName,
      ),
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

  // ─── Care Plans ─────────────────────────────────────────────────────────

  /// GET /staff/patients/:patientUid/care-plans — staff-scoped care-plan view.
  static Future<Map<String, dynamic>> getPatientCarePlans(
    String patientUid, {
    String? status,
  }) async {
    final query = <String, String>{};
    if (status != null && status.trim().isNotEmpty) {
      query['status'] = status.trim();
    }
    return _get('/staff/patients/$patientUid/care-plans', query: query);
  }

  /// PATCH /staff/care-plans/goals/:goalId/progress.
  static Future<Map<String, dynamic>> updateCarePlanGoalProgress(
    int goalId, {
    String? status,
    String? currentValue,
  }) async {
    final body = <String, dynamic>{};
    if (status != null && status.trim().isNotEmpty) {
      body['status'] = status.trim();
    }
    if (currentValue != null && currentValue.trim().isNotEmpty) {
      body['current_value'] = currentValue.trim();
    }
    return _patch('/staff/care-plans/goals/$goalId/progress', body);
  }

  /// PATCH /staff/care-plans/activities/:activityId/complete.
  static Future<Map<String, dynamic>> completeCarePlanActivity(
    int activityId,
  ) async {
    return _patch('/staff/care-plans/activities/$activityId/complete', {
      'status': 'completed',
    });
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
        await ApiClient.multipartFileFromPath('handwritten_photo', photo.path),
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

  /// GET /prescriptions/appointment/:appointmentId — the single OP
  /// prescription linked to a consultation visit.
  static Future<Map<String, dynamic>> getEPrescriptionByAppointment(
    int appointmentId,
  ) async {
    return _get('/prescriptions/appointment/$appointmentId');
  }

  /// PUT /prescriptions/:id — edit an unsigned draft prescription.
  static Future<Map<String, dynamic>> updateEPrescription(
    int id,
    Map<String, dynamic> data,
  ) async {
    return _put('/prescriptions/$id', data);
  }

  /// POST /prescriptions/:id/sign — sign and lock a prescription.
  static Future<Map<String, dynamic>> signEPrescription(int id) async {
    return _post('/prescriptions/$id/sign', {});
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
    DateTime? administeredAt,
  }) async {
    return _post('/clinical/mar/$maId/administer-with-scan', {
      'scanned_patient_uid': scannedPatientUid,
      'scanned_barcode': scannedBarcode,
      'override_reason': ?overrideReason,
      if (administeredAt != null)
        'administered_at': administeredAt.toUtc().toIso8601String(),
    });
  }

  /// GET /devices/registry — active clinical devices for bedside association.
  static Future<List<Map<String, dynamic>>> listClinicalDevices() async {
    final data = await _get('/devices/registry', query: {'status': 'active'});
    final rows = data['devices'] ?? data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  /// GET /devices/associations — active associations for a patient/device.
  static Future<List<Map<String, dynamic>>> listDeviceAssociations({
    String? patientUid,
  }) async {
    final query = <String, String>{};
    if (patientUid != null && patientUid.isNotEmpty) {
      query['patient_uid'] = patientUid;
    }
    final data = await _get('/devices/associations', query: query);
    final rows = data['associations'] ?? data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  /// POST /devices/associations — scanned bedside device association.
  static Future<Map<String, dynamic>> associateDevice({
    required String patientUid,
    required String deviceCode,
    String channel = '',
  }) async {
    return _post('/devices/associations', {
      'patient_uid': patientUid,
      'device_code': deviceCode,
      'channel': channel,
      'start_method': 'scan',
    });
  }

  /// POST /devices/associations/:id/disconnect.
  static Future<Map<String, dynamic>> disconnectDeviceAssociation(int id) {
    return _post('/devices/associations/$id/disconnect', {
      'end_reason': 'manual',
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

  /// GET /clinical/drug-chart/admission/:id — inpatient drug chart for the
  /// current admission, including CPOE medication orders, MAR rows, ward
  /// indents, safety flags, and role permissions.
  static Future<Map<String, dynamic>> getInpatientDrugChart(
    int admissionId,
  ) async {
    return _get('/clinical/drug-chart/admission/$admissionId');
  }

  /// POST /emr/orders — doctor-only inpatient medication order. The backend
  /// schedules MAR rows and creates the pharmacy ward indent as side effects.
  static Future<Map<String, dynamic>> createInpatientMedicationOrder({
    required String patientUid,
    required String? encounterId,
    required String medicationName,
    required String dose,
    required String route,
    required String frequency,
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
    DateTime? startDate,
  }) async {
    return _post(
      '/emr/orders',
      buildInpatientMedicationOrderBody(
        patientUid: patientUid,
        encounterId: encounterId,
        medicationName: medicationName,
        dose: dose,
        route: route,
        frequency: frequency,
        durationDays: durationDays,
        doseTimes: doseTimes,
        foodTiming: foodTiming,
        instructions: instructions,
        catalogId: catalogId,
        originalCatalogId: originalCatalogId,
        compositionId: compositionId,
        compositionLabel: compositionLabel,
        compositionConfidence: compositionConfidence,
        genericName: genericName,
        strength: strength,
        strengthKey: strengthKey,
        form: form,
        formKey: formKey,
        releaseKey: releaseKey,
        doNotSubstitute: doNotSubstitute,
        priority: priority,
        startDate: startDate ?? DateTime.now(),
      ),
    );
  }

  /// GET /pharmacy-orders/catalog — shared formulary suggestions for inpatient
  /// and outpatient prescription type-ahead. This intentionally uses the
  /// pharmacy catalog namespace because older deployed backends may route
  /// `/prescriptions/catalog` through the dynamic `/:id` prescription detail
  /// route and return "Invalid prescription id".
  static Future<List<Map<String, dynamic>>> searchMedicationCatalog(
    String search, {
    int minLength = 2,
  }) async {
    final q = search.trim();
    if (q.length < minLength) return const [];
    final data = await _get('/pharmacy-orders/catalog', query: {'search': q});
    final rows = data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  /// GET /pharmacy-orders/catalog/:id/alternatives — same-composition sibling
  /// brands for a selected pharmacy catalog row. A flag-off tenant returns a
  /// valid empty result (`selected: null, groups: []`).
  static Future<CompositionAlternativesResult> getCatalogAlternatives(
    int catalogId,
  ) async {
    final data = await _get('/pharmacy-orders/catalog/$catalogId/alternatives');
    return CompositionAlternativesResult.fromJson(data);
  }

  static Future<Map<String, dynamic>> orderPrescriptionToPharmacy(
    int prescriptionId, {
    String deliveryType = 'counter',
    List<Map<String, dynamic>>? medications,
  }) async {
    return _post('/prescriptions/$prescriptionId/order-pharmacy', {
      'delivery_type': deliveryType,
      'medications': ?medications,
    });
  }

  static Future<String?> getPrescriptionPdfUrl(int prescriptionId) async {
    final data = await _get('/prescriptions/pdf/$prescriptionId');
    return data['url']?.toString();
  }

  static Future<Uint8List> downloadPrescriptionPrintPdf(
    int prescriptionId,
  ) async {
    final response = await ApiClient.getBytes(
      '/prescriptions/$prescriptionId/print-pdf',
      timeout: const Duration(seconds: 30),
    );
    return _pdfBytesFrom(response, 'Prescription PDF download failed');
  }

  // ─── Ward Referrals ─────────────────────────────────────────────────────

  static Future<List<Map<String, dynamic>>> searchReferralConsultants({
    String query = '',
    String department = '',
  }) async {
    final data = await _get(
      '/referrals/consultants',
      query: {
        if (query.trim().isNotEmpty) 'q': query.trim(),
        if (department.trim().isNotEmpty) 'department': department.trim(),
        'limit': '50',
      },
    );
    final rows = data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  static Future<List<Map<String, dynamic>>> getIncomingReferrals({
    String? status,
  }) async {
    final data = await _get(
      '/referrals/incoming',
      query: {if (status != null && status.isNotEmpty) 'status': status},
    );
    final rows = data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  static Future<List<Map<String, dynamic>>> getOutgoingReferrals({
    String? status,
  }) async {
    final data = await _get(
      '/referrals/outgoing',
      query: {if (status != null && status.isNotEmpty) 'status': status},
    );
    final rows = data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  static Future<List<Map<String, dynamic>>> getReferralAudit({
    String? status,
    String? department,
    String? dateFrom,
    String? dateTo,
  }) async {
    final data = await _get(
      '/referrals/audit',
      query: {
        if (status != null && status.isNotEmpty) 'status': status,
        if (department != null && department.isNotEmpty)
          'department': department,
        if (dateFrom != null && dateFrom.isNotEmpty) 'date_from': dateFrom,
        if (dateTo != null && dateTo.isNotEmpty) 'date_to': dateTo,
        'limit': '100',
      },
    );
    final rows = data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  static Future<Map<String, dynamic>> createWardReferral({
    required String patientUid,
    required String department,
    required String reason,
    String? encounterId,
    String? referredToDoctor,
    int? admissionId,
    String urgency = 'routine',
    String? clinicalSummary,
  }) async {
    return _post('/referrals', {
      'patient_uid': patientUid,
      'encounter_id': ?encounterId,
      'admission_id': ?admissionId,
      'referred_to_department': department,
      'referred_to_doctor': ?referredToDoctor,
      'reason': reason,
      'urgency': urgency,
      'clinical_summary': ?clinicalSummary,
      'source': 'ward',
    });
  }

  static Future<Map<String, dynamic>> markReferralSeen(int referralId) async {
    return _put('/referrals/$referralId/seen', {});
  }

  static Future<Map<String, dynamic>> acceptReferral(int referralId) async {
    return _put('/referrals/$referralId/accept', {});
  }

  static Future<Map<String, dynamic>> completeReferral(
    int referralId, {
    String? responseNotes,
  }) async {
    return _put('/referrals/$referralId/complete', {
      'response_notes': ?responseNotes,
    });
  }

  static Future<Map<String, dynamic>> declineReferral(
    int referralId, {
    String? reason,
  }) async {
    return _put('/referrals/$referralId/decline', {
      'reason': reason ?? 'Not appropriate for this service',
      'response_notes': ?reason,
    });
  }

  /// PUT /emr/orders/:id/discontinue — doctor-only stop order.
  static Future<Map<String, dynamic>> discontinueClinicalOrder({
    required int orderId,
    required String reason,
  }) async {
    return _put('/emr/orders/$orderId/discontinue', {'reason': reason});
  }

  /// POST /clinical/mar/:id/administer — nurse administration without barcode.
  /// The preferred path is the scanner, but this supports supervised downtime
  /// confirmation while still storing scheduled/administered timestamps.
  static Future<Map<String, dynamic>> administerMedication({
    required int maId,
    String? notes,
  }) async {
    return _post('/clinical/mar/$maId/administer', {'notes': ?notes});
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
    int? patientId,
    String? patientPhone,
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
      if (patientId != null) 'patient_id': patientId.toString(),
      if (patientPhone != null && patientPhone.trim().isNotEmpty)
        'patient_phone': patientPhone.trim(),
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
      await ApiClient.multipartFileFromPath(
        'file',
        filePath,
        filename: fileName,
      ),
    ];
    final resp = await ApiClient.multipart(
      '/appointments/patient/records/upload',
      fields: fields,
      files: files,
    );
    return _handle(resp);
  }

  /// GET /appointments/patient/records/all — staff-visible prior records.
  static Future<Map<String, dynamic>> getPatientAllRecords({
    int? patientId,
    String? patientUid,
    String? patientPhone,
  }) async {
    return _get(
      '/appointments/patient/records/all',
      query: {
        if (patientId != null) 'patient_id': patientId.toString(),
        'patient_uid': ?patientUid,
        'patient_phone': ?patientPhone,
      },
    );
  }

  /// GET /appointments/patient/records/:id/extraction — OCR/AI draft detail.
  static Future<Map<String, dynamic>> getPatientPriorRecordExtraction(
    Object recordId,
  ) async {
    return _get('/appointments/patient/records/$recordId/extraction');
  }

  /// PATCH /appointments/patient/records/:id/extraction-review — staff review.
  static Future<Map<String, dynamic>> reviewPatientPriorRecordExtraction({
    required Object recordId,
    required String decision,
    String? note,
  }) async {
    return _patch('/appointments/patient/records/$recordId/extraction-review', {
      'decision': decision,
      if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
    });
  }

  // ─── EMR: Admissions ──────────────────────────────────────────────────────

  /// POST /admissions — admission-desk-safe patient admission.
  static Future<Map<String, dynamic>> admitPatient(
    Map<String, dynamic> data,
  ) async {
    return _post('/admissions', data);
  }

  /// POST /consent/:id/signatures — immutable PNG signature capture.
  static Future<Map<String, dynamic>> uploadConsentSignature({
    required int consentId,
    required String signatureRole,
    required Uint8List pngBytes,
    String? signerName,
  }) async {
    final resp = await ApiClient.multipart(
      '/consent/$consentId/signatures',
      fields: {
        'signature_role': signatureRole,
        if (signerName != null && signerName.trim().isNotEmpty)
          'signer_name': signerName.trim(),
      },
      files: [
        http.MultipartFile.fromBytes(
          'file',
          pngBytes,
          filename: '$signatureRole-signature.png',
          contentType: MediaType('image', 'png'),
        ),
      ],
    );
    return _handle(resp);
  }

  /// GET /admissions/lookup — reception-counter IP lookup by patient phone.
  static Future<Map<String, dynamic>> lookupAdmissionPatient({
    required String phone,
  }) async {
    return _get('/admissions/lookup', query: {'phone': phone});
  }

  /// GET /admissions/ward-options — admission desk ward/floor dropdown.
  static Future<List<Map<String, dynamic>>> getAdmissionWardOptions() async {
    final data = await _get('/admissions/ward-options');
    final rows = data['wards'] ?? data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  /// GET /admissions/bed-options — available bed dropdown for admission desk.
  static Future<List<Map<String, dynamic>>> getAdmissionBedOptions({
    int? wardId,
    String? wardLabel,
  }) async {
    final data = await _get(
      '/admissions/bed-options',
      query: {
        if (wardId != null) 'ward_id': wardId.toString(),
        if (wardLabel != null && wardLabel.trim().isNotEmpty)
          'ward_label': wardLabel.trim(),
      },
    );
    final rows = data['beds'] ?? data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  /// POST /emr/:id/discharge — discharge a patient
  static Future<Map<String, dynamic>> dischargePatient(
    int id,
    Map<String, dynamic> data,
  ) async {
    return _post('/emr/$id/discharge', data);
  }

  /// GET /admissions/:id/discharge-hub — role-owned discharge workflow
  static Future<Map<String, dynamic>> getDischargeHub(int id) async {
    return _get('/admissions/$id/discharge-hub');
  }

  /// GET /admissions/discharge-hub — central active discharge worklist
  static Future<Map<String, dynamic>> listDischargeHubs() async {
    return _get('/admissions/discharge-hub');
  }

  /// POST /admissions/:id/consults/:type/complete — finish discharge work
  static Future<Map<String, dynamic>> completeDischargeWorkItem(
    int id,
    String consultType, {
    String? notes,
  }) async {
    return _post('/admissions/$id/consults/$consultType/complete', {
      if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
    });
  }

  /// POST /admissions/:id/mark-drugs-dispensed — pharmacy handover marker
  static Future<Map<String, dynamic>> markDischargeDrugsDispensed(int id) {
    return _post('/admissions/$id/mark-drugs-dispensed', {});
  }

  /// GET /emr/:id/discharge-summary — load latest saved/generated summary
  static Future<Map<String, dynamic>> getDischargeSummary(int id) async {
    return _get('/emr/$id/discharge-summary');
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

  static Future<Uint8List> downloadDischargeSummaryPdfForAdmission(
    int admissionId,
  ) async {
    final response = await ApiClient.getBytes(
      '/discharge-summaries/admission/$admissionId/pdf',
      timeout: const Duration(seconds: 30),
    );
    return _pdfBytesFrom(response, 'Discharge summary PDF download failed');
  }

  /// GET /admissions — list active admissions through the ADT surface
  static Future<Map<String, dynamic>> getActiveAdmissions({
    int page = 1,
    int limit = 50,
    String? ward,
    String? status,
  }) async {
    final resp = await ApiClient.get(
      '/admissions',
      queryParameters: {
        'page': '$page',
        'limit': '$limit',
        if (ward != null && ward.trim().isNotEmpty) 'ward': ward.trim(),
        if (status != null && status.trim().isNotEmpty) 'status': status.trim(),
      },
    );
    if (resp.isSuccess && resp.raw is Map<String, dynamic>) {
      final raw = resp.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        final data = raw['data'];
        final meta = raw['meta'];
        final pagination = meta is Map ? meta['pagination'] : null;
        final scope = meta is Map ? meta['scope'] : null;
        final list = data is List
            ? data
            : data is Map
            ? (data['admissions'] ?? data['items'] ?? data['data'])
            : const [];
        return {
          'admissions': list is List ? list : const [],
          if (pagination is Map)
            'pagination': Map<String, dynamic>.from(pagination),
          if (scope is Map) 'scope': Map<String, dynamic>.from(scope),
        };
      }
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  /// GET /admissions/:id — admission detail
  static Future<Map<String, dynamic>> getAdmissionDetail(int id) async {
    final data = await _get('/admissions/$id');
    final admission = data['admission'];
    if (admission is Map<String, dynamic>) return admission;
    if (admission is Map) return admission.cast<String, dynamic>();
    return data;
  }

  /// GET /admissions/:id/case-sheet — admission baseline history/exam
  static Future<Map<String, dynamic>> getAdmissionCaseSheet(int id) async {
    return _get('/admissions/$id/case-sheet');
  }

  /// PUT /admissions/:id/case-sheet — save admission baseline history/exam
  static Future<Map<String, dynamic>> saveAdmissionCaseSheet(
    int id,
    Map<String, dynamic> caseSheet,
  ) async {
    return _put('/admissions/$id/case-sheet', {'case_sheet': caseSheet});
  }

  /// GET /admissions/command-board — role-aware live inpatient command board.
  static Future<Map<String, dynamic>> getPatientCommandBoard({
    String? ward,
    String? patientUid,
    int? admissionId,
    String status = 'active',
    bool? mine,
    int limit = 200,
    int offset = 0,
  }) async {
    return _get(
      '/admissions/command-board',
      query: {
        if (ward != null && ward.trim().isNotEmpty) 'ward': ward.trim(),
        if (patientUid != null && patientUid.trim().isNotEmpty)
          'patient_uid': patientUid.trim(),
        if (admissionId != null && admissionId > 0)
          'admission_id': admissionId.toString(),
        'status': status,
        if (mine != null) 'mine': mine ? 'true' : 'false',
        'limit': limit.toString(),
        if (offset > 0) 'offset': offset.toString(),
      },
    );
  }

  /// GET /burns/charts — burn charts for one patient/context.
  static Future<Map<String, dynamic>> getBurnCharts({
    String? patientUid,
    int? emergencyVisitId,
    int? admissionId,
    int? mlcRecordId,
    int limit = 20,
  }) async {
    return _get(
      '/burns/charts',
      query: {
        if (patientUid != null && patientUid.trim().isNotEmpty)
          'patient_uid': patientUid.trim(),
        if (emergencyVisitId != null && emergencyVisitId > 0)
          'emergency_visit_id': emergencyVisitId.toString(),
        if (admissionId != null && admissionId > 0)
          'admission_id': admissionId.toString(),
        if (mlcRecordId != null && mlcRecordId > 0)
          'mlc_record_id': mlcRecordId.toString(),
        'limit': limit.toString(),
      },
    );
  }

  /// POST /burns/charts — open a burn chart linked to ED/IP/MLC context.
  static Future<Map<String, dynamic>> createBurnChart({
    required String mechanism,
    String? patientUid,
    int? emergencyVisitId,
    int? admissionId,
    int? mlcRecordId,
    String? firstAid,
    bool inhalationRisk = false,
    bool circumferentialBurns = false,
  }) async {
    return _post('/burns/charts', {
      'mechanism': mechanism,
      if (patientUid != null && patientUid.trim().isNotEmpty)
        'patient_uid': patientUid.trim(),
      if (emergencyVisitId != null && emergencyVisitId > 0)
        'emergency_visit_id': emergencyVisitId,
      if (admissionId != null && admissionId > 0) 'admission_id': admissionId,
      if (mlcRecordId != null && mlcRecordId > 0) 'mlc_record_id': mlcRecordId,
      if (firstAid != null && firstAid.trim().isNotEmpty)
        'first_aid': firstAid.trim(),
      'inhalation_risk': inhalationRisk,
      'circumferential_burns': circumferentialBurns,
    });
  }

  /// POST /burns/charts/:id/tbsa-regions — save TBSA body-map regions.
  static Future<Map<String, dynamic>> recordBurnTbsaRegions({
    required int burnChartId,
    required String referenceKey,
    required List<Map<String, dynamic>> regions,
  }) async {
    return _post('/burns/charts/$burnChartId/tbsa-regions', {
      'reference_key': referenceKey,
      'regions': regions,
    });
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
    int page = 1,
    int limit = 20,
  }) async {
    return _get(
      '/emr/notes/patient/$uid',
      query: {
        if (noteType != null && noteType.trim().isNotEmpty)
          'note_type': noteType.trim(),
        'page': page.toString(),
        'limit': limit.toString(),
      },
    );
  }

  /// GET /patients/:uid/timeline — canonical patient timeline.
  /// Falls back to `/emr/timeline/:uid`, which is a canonical compatibility alias.
  static Future<Map<String, dynamic>> getPatientTimeline(String uid) async {
    try {
      final timeline = await ClinicalPlatformApiService.getPatientTimeline(uid);
      return {
        'data': timeline.events.map((event) => event.toLegacyMap()).toList(),
        'canonical': true,
        'counts': timeline.counts,
        'generated_at': timeline.generatedAt?.toIso8601String(),
      };
    } catch (_) {
      return _get('/emr/timeline/$uid');
    }
  }

  /// POST /emr/notes/:id/sign — sign a clinical note
  static Future<Map<String, dynamic>> signNote(int id) async {
    return _post('/emr/notes/$id/sign', {});
  }

  /// PUT /emr/notes/:id — edit note content.
  /// Admin/SuperAdmin can correct prior notes. The original assigned doctor
  /// can revise their own unsigned OP appointment note while that appointment
  /// is still active; signed/terminal notes require an addendum.
  static Future<Map<String, dynamic>> updateClinicalNote(
    int id,
    Map<String, dynamic> content,
  ) async {
    return _put('/emr/notes/$id', {'content': content});
  }

  // ─── EMR: Clinical Note Drafts (autosave scratchpad) ──────────────────────
  //
  // Drafts are an author-private, server-side scratchpad for in-progress
  // OP/nursing notes. They emit NO canonical timeline/audit events — only the
  // existing finalize path (`createClinicalNote`/`signNote`) does. See
  // docs/superpowers/specs/2026-06-17-clinical-notes-autosave-design.md.

  /// PUT /emr/notes/draft — upsert the author's in-progress note draft for a
  /// (patient, encounter, note_type) context. [content] is a free-form field
  /// map (OP: `{chief_complaint,history,examination,diagnosis,plan,...}`;
  /// nursing: `{body}`). Returns `{ id, updated_at }`.
  static Future<Map<String, dynamic>> putNoteDraft({
    required String patientUid,
    int? appointmentId,
    required String noteType,
    required Map<String, dynamic> content,
  }) async {
    return _put('/emr/notes/draft', {
      'patient_uid': patientUid,
      'appointment_id': ?appointmentId,
      'note_type': noteType,
      'content': content,
    });
  }

  /// GET /emr/notes/draft — fetch the author's own draft for the context.
  /// Returns the draft map `{ id, content, updated_at, expires_at }`, or
  /// `null` when there is no saved draft (`{ data: null }` envelope).
  static Future<Map<String, dynamic>?> getNoteDraft({
    required String patientUid,
    int? appointmentId,
    required String noteType,
  }) async {
    final resp = await ApiClient.get(
      '/emr/notes/draft',
      queryParameters: {
        'patient_uid': patientUid,
        if (appointmentId != null) 'appointment_id': appointmentId.toString(),
        'note_type': noteType,
      },
    );
    if (!resp.isSuccess || resp.raw is! Map) {
      throw Exception(
        resp.message ?? 'Failed to load note draft (${resp.statusCode})',
      );
    }
    final raw = resp.raw as Map<String, dynamic>;
    if (raw['success'] != true) {
      throw Exception(
        raw['message']?.toString() ?? 'Failed to load note draft',
      );
    }
    final data = raw['data'];
    if (data is Map<String, dynamic>) return data;
    if (data is Map) return data.cast<String, dynamic>();
    return null; // { data: null } — no draft for this context.
  }

  /// DELETE /emr/notes/draft — remove the author's draft for the context.
  /// Called on finalize as a backstop to the server-side post-commit delete.
  /// Returns `{ removed }`.
  static Future<Map<String, dynamic>> deleteNoteDraft({
    required String patientUid,
    int? appointmentId,
    required String noteType,
  }) async {
    final query = <String, String>{
      'patient_uid': patientUid,
      if (appointmentId != null) 'appointment_id': appointmentId.toString(),
      'note_type': noteType,
    };
    final uri = Uri(path: '/emr/notes/draft', queryParameters: query);
    final resp = await ApiClient.delete(uri.toString());
    return _handle(resp);
  }

  // ─── EMR: Orders ──────────────────────────────────────────────────────────

  /// POST /emr/orders — create an order (medication, investigation, nursing)
  static Future<Map<String, dynamic>> createEmrOrder(
    Map<String, dynamic> data,
  ) async {
    return _post('/emr/orders', data);
  }

  /// POST /emr/orders/bulk — create up to 50 orders atomically (one
  /// transaction; per-item CDS runs server-side before any row is written).
  /// Returns the raw [ApiResponse] so the composer can read the structured
  /// `details.{order_index, blockers, warnings}` payload of a 400
  /// CDS_BLOCKER envelope — the `_handle` helper would flatten it to a
  /// message-only Exception.
  static Future<ApiResponse> createEmrOrdersBulkRaw(
    List<Map<String, dynamic>> orders, {
    String? encounterId,
  }) {
    return ApiClient.post(
      '/emr/orders/bulk',
      body: {
        'orders': orders,
        if (encounterId != null && encounterId.isNotEmpty)
          'encounter_id': encounterId,
      },
    );
  }

  /// GET /investigations/catalog — searchable test catalog (labs, imaging,
  /// ECG; `search` matches name + code case-insensitively).
  static Future<List<Map<String, dynamic>>> searchInvestigationCatalog(
    String search, {
    String? category,
    int minLength = 2,
  }) async {
    final q = search.trim();
    if (q.length < minLength) return const [];
    final data = await _get(
      '/investigations/catalog',
      query: {'search': q, 'category': ?category},
    );
    final rows = data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  /// PUT /emr/orders/:id/cancel — cancel an order with a mandatory reason.
  static Future<Map<String, dynamic>> cancelClinicalOrder({
    required int orderId,
    required String reason,
  }) async {
    return _put('/emr/orders/$orderId/cancel', {'reason': reason});
  }

  /// GET /emr/orders/patient/:uid — list orders for a patient
  static Future<Map<String, dynamic>> getPatientOrders(String uid) async {
    return _get('/emr/orders/patient/$uid');
  }

  /// GET /problems/patient/:uid — longitudinal problem list (B7).
  static Future<List<Map<String, dynamic>>> getPatientProblems(
    String uid, {
    String? status,
  }) async {
    final data = await _get(
      '/problems/patient/$uid',
      query: {'status': ?status},
    );
    final rows = data['problems'] ?? data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  /// GET /allergies/patient/:uid/unified — union of all four allergy
  /// stores (A10 over HTTP; E5 follow-up), valid for any patient,
  /// admitted or not. Rows are shaped {allergen, severity?, sources}.
  static Future<List<Map<String, dynamic>>> getUnifiedAllergies(
    String uid,
  ) async {
    final data = await _get('/allergies/patient/$uid/unified');
    final rows = data['allergies'] ?? data['data'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
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

  /// GET /emr/vitals/:uid/chart — full vitals rows for the patient
  static Future<Map<String, dynamic>> getVitalsChart(String uid) async {
    return _get('/emr/vitals/$uid/chart', query: {'limit': '100'});
  }

  /// GET /emr/vitals/:patient/latest — latest vitals by patient uid or int id
  static Future<Map<String, dynamic>> getLatestVitals(String patient) async {
    return _get('/emr/vitals/$patient/latest');
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

  /// GET /emr/io/:uid/chart — I/O rows for history views
  static Future<Map<String, dynamic>> getIOChart(String uid) async {
    return _get('/emr/io/$uid/chart');
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

  /// GET /terminology/search — search standard clinical terminology
  static Future<Map<String, dynamic>> searchTerminology({
    required String system,
    required String query,
    int limit = 20,
  }) async {
    return _get(
      '/terminology/search',
      query: {'system': system, 'q': query, 'limit': '$limit'},
    );
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

  static Uint8List _pdfBytesFrom(http.Response response, String fallback) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.bodyBytes;
    }
    final parsed = ApiResponse.parse(response.statusCode, response.body);
    throw Exception(parsed.message ?? '$fallback (${response.statusCode})');
  }
}
