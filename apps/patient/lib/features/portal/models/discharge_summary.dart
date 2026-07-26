class DischargeSummary {
  const DischargeSummary({
    required this.id,
    required this.admissionId,
    required this.primaryDiagnosis,
    required this.status,
    required this.sections,
    this.pendingResults = const [],
    this.patientName,
    this.hospitalNumber,
    this.admittedAt,
    this.dischargedAt,
    this.wardAtDischarge,
    this.signedByName,
    this.signedAt,
    this.deliveredAt,
    this.deliveryMethod,
    this.createdAt,
    this.updatedAt,
  });

  factory DischargeSummary.fromJson(Map<String, dynamic> json) {
    return DischargeSummary(
      id: _asInt(json['id']),
      admissionId: _asInt(json['admission_id']),
      primaryDiagnosis: json['primary_diagnosis']?.toString().trim() ?? '',
      status: json['status']?.toString().trim() ?? '',
      patientName: json['patient_name_snapshot']?.toString().trim(),
      hospitalNumber: json['hospital_number']?.toString().trim(),
      admittedAt: _parseDate(json['admitted_at']),
      dischargedAt: _parseDate(json['discharged_at']),
      wardAtDischarge: json['ward_at_discharge']?.toString().trim(),
      signedByName: json['signed_by_name']?.toString().trim(),
      signedAt: _parseDate(json['signed_at']),
      deliveredAt: _parseDate(json['delivered_at']),
      deliveryMethod: json['delivery_method']?.toString().trim(),
      createdAt: _parseDate(json['created_at']),
      updatedAt: _parseDate(json['updated_at']),
      sections: (json['sections'] as List? ?? const [])
          .whereType<Map>()
          .map(
            (item) => DischargeSummarySection.fromJson(
              Map<String, dynamic>.from(item),
            ),
          )
          .toList(),
      pendingResults: (json['pending_results'] as List? ?? const [])
          .whereType<Map>()
          .map(
            (item) => DischargePendingResult.fromJson(
              Map<String, dynamic>.from(item),
            ),
          )
          .where((item) => item.label.isNotEmpty)
          .toList(growable: false),
    );
  }

  final int id;
  final int admissionId;
  final String primaryDiagnosis;
  final String status;
  final String? patientName;
  final String? hospitalNumber;
  final DateTime? admittedAt;
  final DateTime? dischargedAt;
  final String? wardAtDischarge;
  final String? signedByName;
  final DateTime? signedAt;
  final DateTime? deliveredAt;
  final String? deliveryMethod;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final List<DischargeSummarySection> sections;
  final List<DischargePendingResult> pendingResults;

  DateTime? get displayDate => dischargedAt ?? signedAt ?? createdAt;

  bool get canShowPendingResults =>
      (status == 'signed' || status == 'delivered') &&
      pendingResults.isNotEmpty;
}

class DischargeSummarySection {
  const DischargeSummarySection({
    required this.key,
    required this.title,
    required this.body,
    required this.translations,
    required this.displayOrder,
  });

  factory DischargeSummarySection.fromJson(Map<String, dynamic> json) {
    final rawTranslations = json['body_translations'];
    return DischargeSummarySection(
      key: json['section_key']?.toString() ?? '',
      title: json['section_title']?.toString().trim() ?? '',
      body: json['body']?.toString().trim() ?? '',
      translations: rawTranslations is Map
          ? Map<String, dynamic>.from(rawTranslations).map(
              (key, value) => MapEntry(key.toString(), value?.toString() ?? ''),
            )
          : const {},
      displayOrder: _asInt(json['display_order']),
    );
  }

  final String key;
  final String title;
  final String body;
  final Map<String, String> translations;
  final int displayOrder;

  String bodyForLanguage(String languageCode) {
    final translated = translations[languageCode]?.trim();
    if (translated != null && translated.isNotEmpty) return translated;
    return body;
  }
}

class DischargePendingResult {
  const DischargePendingResult({
    required this.label,
    required this.status,
    this.responsibleClinicianDisplayName,
    this.responsibleClinicianRole,
  });

  factory DischargePendingResult.fromJson(Map<String, dynamic> json) {
    return DischargePendingResult(
      label: json['label']?.toString().trim() ?? '',
      status: json['status']?.toString().trim() ?? '',
      responsibleClinicianDisplayName:
          json['responsible_clinician_display_name']?.toString().trim(),
      responsibleClinicianRole: json['responsible_clinician_role']
          ?.toString()
          .trim(),
    );
  }

  final String label;
  final String status;
  final String? responsibleClinicianDisplayName;
  final String? responsibleClinicianRole;
}

int _asInt(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

DateTime? _parseDate(dynamic value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString())?.toLocal();
}
