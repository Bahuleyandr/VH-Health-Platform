import '../../../core/services/api_client.dart';

/// NL-13 P4 — radiation-oncology / nuclear-medicine coordination summary.
/// Read-only view of referrals coordinated by the backend; the app stores
/// external references and status only and never drives planning/delivery.
class RadiationReferralSummary {
  const RadiationReferralSummary({
    required this.id,
    required this.patientUid,
    required this.patientName,
    required this.intent,
    required this.modality,
    required this.urgency,
    required this.status,
    required this.planRefCount,
    required this.nuclearOrderCount,
    required this.createdAt,
  });

  final int id;
  final String patientUid;
  final String patientName;
  final String intent;
  final String modality;
  final String urgency;
  final String status;
  final int planRefCount;
  final int nuclearOrderCount;
  final DateTime? createdAt;

  factory RadiationReferralSummary.fromJson(Map<String, dynamic> json) {
    return RadiationReferralSummary(
      id: _asInt(json['id']) ?? 0,
      patientUid: _text(json['patient_uid']),
      patientName: _text(json['patient_name']),
      intent: _text(json['intent'], fallback: 'curative'),
      modality: _text(json['modality'], fallback: 'external_beam'),
      urgency: _text(json['urgency'], fallback: 'routine'),
      status: _text(json['status'], fallback: 'draft'),
      planRefCount: _asInt(json['plan_ref_count']) ?? 0,
      nuclearOrderCount: _asInt(json['nuclear_order_count']) ?? 0,
      createdAt: _date(json['created_at']),
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

class RadiationOncologyApiService {
  RadiationOncologyApiService._();

  static Future<List<RadiationReferralSummary>> fetchReferrals() async {
    final response = await ApiClient.get(
      '/radiation-oncology/referrals',
      queryParameters: {'limit': '100'},
    );
    if (!response.isSuccess) {
      throw Exception(
        response.failureMessage('Failed to load radiation-oncology referrals'),
      );
    }
    final data = response.dataAsMap();
    final rawReferrals = data['referrals'];
    if (rawReferrals is! List) return const [];
    return rawReferrals
        .whereType<Map>()
        .map(
          (raw) =>
              RadiationReferralSummary.fromJson(Map<String, dynamic>.from(raw)),
        )
        .toList();
  }
}
