import '../../../core/services/api_client.dart';
import '../models/dental_models.dart';

abstract class DentalApiTransport {
  Future<ApiResponse> get(String path, {Map<String, String>? queryParameters});

  Future<ApiResponse> post(String path, {Map<String, dynamic>? body});
}

class ApiClientDentalTransport implements DentalApiTransport {
  const ApiClientDentalTransport();

  @override
  Future<ApiResponse> get(String path, {Map<String, String>? queryParameters}) {
    return ApiClient.get(path, queryParameters: queryParameters);
  }

  @override
  Future<ApiResponse> post(String path, {Map<String, dynamic>? body}) {
    return ApiClient.post(path, body: body);
  }
}

class DentalApiService {
  final DentalApiTransport _transport;

  const DentalApiService([this._transport = const ApiClientDentalTransport()]);

  Future<DentalChart> getChart(String patientUid) async {
    final data = _dataFrom(
      await _transport.get(
        '/dental/patients/${Uri.encodeComponent(patientUid)}/chart',
      ),
    );
    final chart = data['chart'];
    return DentalChart.fromJson(
      chart is Map ? Map<String, dynamic>.from(chart) : data,
    );
  }

  Future<List<DentalProcedure>> listProcedures(
    String patientUid, {
    String? status,
  }) async {
    final data = _dataFrom(
      await _transport.get(
        '/dental/patients/${Uri.encodeComponent(patientUid)}/procedures',
        queryParameters: {
          if (status != null && status.trim().isNotEmpty) 'status': status,
        },
      ),
    );
    final list = data['procedures'];
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((row) => DentalProcedure.fromJson(Map<String, dynamic>.from(row)))
        .toList(growable: false);
  }

  Future<DentalFinding> recordFinding({
    required String patientUid,
    required DentalFindingDraft draft,
  }) async {
    final data = _dataFrom(
      await _transport.post(
        '/dental/findings',
        body: {
          'patient_uid': patientUid,
          'tooth_fdi': draft.toothFdi,
          'finding': draft.finding,
          if (draft.surface != null && draft.surface!.trim().isNotEmpty)
            'surface': draft.surface,
          if (draft.severity != null && draft.severity!.trim().isNotEmpty)
            'severity': draft.severity,
          if (draft.notes != null && draft.notes!.trim().isNotEmpty)
            'notes': draft.notes,
        },
      ),
    );
    final finding = data['finding'];
    return DentalFinding.fromJson(
      finding is Map ? Map<String, dynamic>.from(finding) : data,
    );
  }

  Future<DentalFinding> resolveFinding({
    required int findingId,
    required String resolutionNote,
  }) async {
    final data = _dataFrom(
      await _transport.post(
        '/dental/findings/$findingId/resolve',
        body: {'resolution_note': resolutionNote},
      ),
    );
    final finding = data['finding'];
    return DentalFinding.fromJson(
      finding is Map ? Map<String, dynamic>.from(finding) : data,
    );
  }

  Future<DentalProcedure> planProcedure({
    required String patientUid,
    required DentalProcedureDraft draft,
  }) async {
    final data = _dataFrom(
      await _transport.post(
        '/dental/procedures',
        body: {
          'patient_uid': patientUid,
          'procedure_name': draft.procedureName,
          if (draft.toothFdi != null && draft.toothFdi!.trim().isNotEmpty)
            'tooth_fdi': draft.toothFdi,
          if (draft.surface != null && draft.surface!.trim().isNotEmpty)
            'surface': draft.surface,
          if (draft.findingId != null) 'finding_id': draft.findingId,
          if (draft.procedureCode != null &&
              draft.procedureCode!.trim().isNotEmpty)
            'procedure_code': draft.procedureCode,
          if (draft.anesthesia != null && draft.anesthesia!.trim().isNotEmpty)
            'anesthesia': draft.anesthesia,
          if (draft.notes != null && draft.notes!.trim().isNotEmpty)
            'notes': draft.notes,
        },
      ),
    );
    final procedure = data['procedure'];
    return DentalProcedure.fromJson(
      procedure is Map ? Map<String, dynamic>.from(procedure) : data,
    );
  }

  Future<DentalProcedure> completeProcedure({
    required int procedureId,
    String? materials,
    String? anesthesia,
    String? notes,
  }) async {
    final data = _dataFrom(
      await _transport.post(
        '/dental/procedures/$procedureId/complete',
        body: {
          if (materials != null && materials.trim().isNotEmpty)
            'materials': materials,
          if (anesthesia != null && anesthesia.trim().isNotEmpty)
            'anesthesia': anesthesia,
          if (notes != null && notes.trim().isNotEmpty) 'notes': notes,
        },
      ),
    );
    final procedure = data['procedure'];
    return DentalProcedure.fromJson(
      procedure is Map ? Map<String, dynamic>.from(procedure) : data,
    );
  }

  static Map<String, dynamic> _dataFrom(ApiResponse response) {
    if (!response.isSuccess) {
      throw Exception(response.failureMessage('Dental request failed'));
    }
    final raw = response.raw;
    if (raw is Map<String, dynamic>) {
      final data = raw['data'];
      if (data is Map<String, dynamic>) return data;
      if (data is Map) return Map<String, dynamic>.from(data);
      return raw;
    }
    return const {};
  }
}
