class StructuredDiagnosticResult {
  const StructuredDiagnosticResult({
    required this.id,
    required this.resultType,
    required this.title,
    required this.sourceVersion,
    required this.signedAt,
    required this.releasedToPatientAt,
    required this.amended,
    this.reportText,
    this.addenda = const [],
  });

  factory StructuredDiagnosticResult.fromJson(Map<String, dynamic> json) {
    return StructuredDiagnosticResult(
      id: _clean(json['id']) ?? '',
      resultType: _clean(json['result_type']) ?? '',
      title: _clean(json['title']) ?? '',
      sourceVersion: _asInt(json['source_version']),
      signedAt: _parseDate(json['signed_at']),
      releasedToPatientAt: _parseDate(json['released_to_patient_at']),
      amended: json['amended'] == true,
      reportText: _clean(json['report_text']),
      addenda: (json['addenda'] as List? ?? const [])
          .whereType<Map>()
          .map(
            (entry) => StructuredDiagnosticAddendum.fromJson(
              Map<String, dynamic>.from(entry),
            ),
          )
          .toList(growable: false),
    );
  }

  final String id;
  final String resultType;
  final String title;
  final int sourceVersion;
  final DateTime? signedAt;
  final DateTime? releasedToPatientAt;
  final bool amended;
  final String? reportText;
  final List<StructuredDiagnosticAddendum> addenda;

  bool get isRadiology => resultType == 'radiology';
}

class StructuredDiagnosticAddendum {
  const StructuredDiagnosticAddendum({
    required this.version,
    required this.text,
    required this.signedAt,
  });

  factory StructuredDiagnosticAddendum.fromJson(Map<String, dynamic> json) {
    return StructuredDiagnosticAddendum(
      version: _asInt(json['version']),
      text: _clean(json['text']) ?? '',
      signedAt: _parseDate(json['signed_at']),
    );
  }

  final int version;
  final String text;
  final DateTime? signedAt;
}

String? _clean(dynamic value) {
  final text = value?.toString().trim();
  if (text == null || text.isEmpty) return null;
  return text;
}

int _asInt(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

DateTime? _parseDate(dynamic value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString())?.toLocal();
}
