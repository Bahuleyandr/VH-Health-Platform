import 'package:flutter/foundation.dart';

@immutable
class DentalFinding {
  final int id;
  final String toothFdi;
  final String? surface;
  final String finding;
  final String? severity;
  final String status;
  final DateTime? recordedAt;
  final String? notes;

  const DentalFinding({
    required this.id,
    required this.toothFdi,
    required this.finding,
    this.surface,
    this.severity,
    this.status = 'active',
    this.recordedAt,
    this.notes,
  });

  factory DentalFinding.fromJson(Map<String, dynamic> json) {
    return DentalFinding(
      id: _intFrom(json['id']),
      toothFdi: _text(json['tooth_fdi'] ?? json['toothFdi']),
      surface: _nullableText(json['surface']),
      finding: _text(json['finding']),
      severity: _nullableText(json['severity']),
      status: _text(json['status'], fallback: 'active'),
      recordedAt: _dateFrom(json['recorded_at'] ?? json['recordedAt']),
      notes: _nullableText(json['notes']),
    );
  }
}

@immutable
class DentalProcedure {
  final int id;
  final String? toothFdi;
  final String? surface;
  final int? findingId;
  final String procedureName;
  final String? procedureCode;
  final String status;
  final DateTime? performedAt;
  final String? anesthesia;
  final String? materials;
  final String? notes;

  const DentalProcedure({
    required this.id,
    required this.procedureName,
    this.toothFdi,
    this.surface,
    this.findingId,
    this.procedureCode,
    this.status = 'planned',
    this.performedAt,
    this.anesthesia,
    this.materials,
    this.notes,
  });

  factory DentalProcedure.fromJson(Map<String, dynamic> json) {
    return DentalProcedure(
      id: _intFrom(json['id']),
      toothFdi: _nullableText(json['tooth_fdi'] ?? json['toothFdi']),
      surface: _nullableText(json['surface']),
      findingId: _nullableIntFrom(json['finding_id'] ?? json['findingId']),
      procedureName: _text(
        json['procedure_name'] ?? json['procedureName'],
        fallback: 'Procedure',
      ),
      procedureCode: _nullableText(
        json['procedure_code'] ?? json['procedureCode'],
      ),
      status: _text(json['status'], fallback: 'planned'),
      performedAt: _dateFrom(json['performed_at'] ?? json['performedAt']),
      anesthesia: _nullableText(json['anesthesia']),
      materials: _nullableText(json['materials']),
      notes: _nullableText(json['notes']),
    );
  }
}

@immutable
class DentalToothSummary {
  final List<DentalFinding> findings;
  final List<DentalProcedure> procedures;

  const DentalToothSummary({
    this.findings = const [],
    this.procedures = const [],
  });

  factory DentalToothSummary.fromJson(Map<String, dynamic> json) {
    final findings = json['findings'];
    final procedures = json['procedures'];
    return DentalToothSummary(
      findings: findings is List
          ? findings
                .whereType<Map>()
                .map(
                  (row) =>
                      DentalFinding.fromJson(Map<String, dynamic>.from(row)),
                )
                .toList(growable: false)
          : const [],
      procedures: procedures is List
          ? procedures
                .whereType<Map>()
                .map(
                  (row) =>
                      DentalProcedure.fromJson(Map<String, dynamic>.from(row)),
                )
                .toList(growable: false)
          : const [],
    );
  }
}

@immutable
class DentalChart {
  final String patientUid;
  final Map<String, DentalToothSummary> teeth;
  final int activeFindingCount;
  final List<DentalProcedure> procedures;

  const DentalChart({
    required this.patientUid,
    this.teeth = const {},
    this.activeFindingCount = 0,
    this.procedures = const [],
  });

  factory DentalChart.fromJson(Map<String, dynamic> json) {
    final rawTeeth = json['teeth'];
    final teeth = <String, DentalToothSummary>{};
    if (rawTeeth is Map) {
      for (final entry in rawTeeth.entries) {
        final value = entry.value;
        if (value is Map) {
          teeth['${entry.key}'] = DentalToothSummary.fromJson(Map.from(value));
        }
      }
    }
    final rawProcedures = json['procedures'];
    return DentalChart(
      patientUid: _text(json['patient_uid'] ?? json['patientUid']),
      teeth: teeth,
      activeFindingCount: _intFrom(
        json['active_finding_count'] ?? json['activeFindingCount'],
      ),
      procedures: rawProcedures is List
          ? rawProcedures
                .whereType<Map>()
                .map(
                  (row) =>
                      DentalProcedure.fromJson(Map<String, dynamic>.from(row)),
                )
                .toList(growable: false)
          : const [],
    );
  }

  DentalToothSummary summaryFor(String toothFdi) {
    return teeth[toothFdi] ?? const DentalToothSummary();
  }
}

@immutable
class FdiToothPosition {
  final String fdi;
  final int row;
  final int column;
  final bool deciduous;
  final String quadrant;

  const FdiToothPosition({
    required this.fdi,
    required this.row,
    required this.column,
    required this.deciduous,
    required this.quadrant,
  });
}

class FdiToothLayout {
  FdiToothLayout._();

  static const permanentUpper = [
    '18',
    '17',
    '16',
    '15',
    '14',
    '13',
    '12',
    '11',
    '21',
    '22',
    '23',
    '24',
    '25',
    '26',
    '27',
    '28',
  ];

  static const permanentLower = [
    '48',
    '47',
    '46',
    '45',
    '44',
    '43',
    '42',
    '41',
    '31',
    '32',
    '33',
    '34',
    '35',
    '36',
    '37',
    '38',
  ];

  static const deciduousUpper = [
    '55',
    '54',
    '53',
    '52',
    '51',
    '61',
    '62',
    '63',
    '64',
    '65',
  ];

  static const deciduousLower = [
    '85',
    '84',
    '83',
    '82',
    '81',
    '71',
    '72',
    '73',
    '74',
    '75',
  ];

  static const rows = [
    permanentUpper,
    permanentLower,
    deciduousUpper,
    deciduousLower,
  ];

  static const allTeeth = [
    ...permanentUpper,
    ...permanentLower,
    ...deciduousUpper,
    ...deciduousLower,
  ];

  static FdiToothPosition positionFor(String fdi) {
    final clean = fdi.trim();
    for (var row = 0; row < rows.length; row++) {
      final column = rows[row].indexOf(clean);
      if (column >= 0) {
        return FdiToothPosition(
          fdi: clean,
          row: row,
          column: column,
          deciduous: row >= 2,
          quadrant: clean[0],
        );
      }
    }
    throw ArgumentError.value(fdi, 'fdi', 'Invalid FDI tooth code');
  }

  static bool isValid(String fdi) {
    final s = fdi.trim();
    if (!RegExp(r'^[1-8][1-8]$').hasMatch(s)) return false;
    final quadrant = int.parse(s[0]);
    final position = int.parse(s[1]);
    return quadrant <= 4 ? position <= 8 : position <= 5;
  }
}

class DentalFindingDraft {
  final String toothFdi;
  final String? surface;
  final String finding;
  final String? severity;
  final String? notes;

  const DentalFindingDraft({
    required this.toothFdi,
    required this.finding,
    this.surface,
    this.severity,
    this.notes,
  });
}

class DentalProcedureDraft {
  final String? toothFdi;
  final String? surface;
  final int? findingId;
  final String procedureName;
  final String? procedureCode;
  final String? anesthesia;
  final String? notes;

  const DentalProcedureDraft({
    required this.procedureName,
    this.toothFdi,
    this.surface,
    this.findingId,
    this.procedureCode,
    this.anesthesia,
    this.notes,
  });
}

const dentalFindingTypes = [
  'caries',
  'filling',
  'crown',
  'bridge_pontic',
  'implant',
  'missing',
  'root_canal_treated',
  'fracture',
  'mobility_grade_1',
  'mobility_grade_2',
  'mobility_grade_3',
  'periapical_lesion',
  'impacted',
  'attrition',
  'abrasion',
  'erosion',
  'gingival_recession',
  'calculus',
  'other',
];

const dentalSurfaces = [
  'mesial',
  'distal',
  'occlusal',
  'buccal',
  'lingual',
  'palatal',
  'incisal',
  'cervical',
  'whole',
];

String dentalLabel(String value) {
  final clean = value.trim();
  if (clean.isEmpty) return '-';
  return clean
      .split('_')
      .map((part) {
        if (part.isEmpty) return part;
        return part[0].toUpperCase() + part.substring(1);
      })
      .join(' ');
}

String _text(Object? value, {String fallback = ''}) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? fallback : text;
}

String? _nullableText(Object? value) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? null : text;
}

int _intFrom(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

int? _nullableIntFrom(Object? value) {
  if (value == null) return null;
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value.toString());
}

DateTime? _dateFrom(Object? value) {
  final text = value?.toString().trim();
  if (text == null || text.isEmpty) return null;
  return DateTime.tryParse(text)?.toLocal();
}
