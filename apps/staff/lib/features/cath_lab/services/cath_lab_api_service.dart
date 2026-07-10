import 'package:intl/intl.dart';

import '../../../core/services/api_client.dart';

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

class CathLabApiService {
  CathLabApiService._();

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
}
