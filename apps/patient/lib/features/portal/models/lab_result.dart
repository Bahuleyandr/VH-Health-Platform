class LabResult {
  const LabResult({
    required this.id,
    required this.testName,
    this.testCode,
    this.loincCode,
    this.observationTime,
    this.valueText,
    this.valueNumeric,
    this.unit,
    this.referenceRange,
    this.abnormalFlag,
    this.signedOffAt,
    this.releasedToPatientAt,
  });

  factory LabResult.fromJson(Map<String, dynamic> json) {
    return LabResult(
      id: _asInt(json['id']),
      testName: _clean(json['test_name']) ?? '',
      testCode: _clean(json['test_code']),
      loincCode: _clean(json['loinc_code']),
      observationTime: _parseDate(json['observation_datetime']),
      valueText: _clean(json['value_text']),
      valueNumeric: _asDouble(json['value_numeric']),
      unit: _clean(json['unit']),
      referenceRange: _clean(json['reference_range']),
      abnormalFlag: _clean(json['abnormal_flag']),
      signedOffAt: _parseDate(json['signed_off_at']),
      releasedToPatientAt: _parseDate(json['released_to_patient_at']),
    );
  }

  final int id;
  final String testName;
  final String? testCode;
  final String? loincCode;
  final DateTime? observationTime;
  final String? valueText;
  final double? valueNumeric;
  final String? unit;
  final String? referenceRange;
  final String? abnormalFlag;
  final DateTime? signedOffAt;
  final DateTime? releasedToPatientAt;

  bool get hasTrendCode =>
      (testCode ?? '').isNotEmpty || (loincCode ?? '').isNotEmpty;

  String? get trendQueryKey {
    if ((testCode ?? '').isNotEmpty) return 'test_code';
    if ((loincCode ?? '').isNotEmpty) return 'loinc_code';
    return null;
  }

  String? get trendQueryValue {
    if ((testCode ?? '').isNotEmpty) return testCode;
    if ((loincCode ?? '').isNotEmpty) return loincCode;
    return null;
  }

  String get displayValue {
    if (valueNumeric != null) return formatLabNumber(valueNumeric!);
    return valueText ?? '';
  }

  bool get isAbnormal {
    final flag = abnormalFlag?.toUpperCase() ?? '';
    return flag.contains('H') || flag.contains('L') || flag.contains('A');
  }
}

class LabResultTrend {
  const LabResultTrend({
    required this.testCode,
    required this.loincCode,
    required this.testName,
    required this.unit,
    required this.months,
    required this.count,
    required this.min,
    required this.max,
    required this.points,
  });

  factory LabResultTrend.fromJson(Map<String, dynamic> json) {
    final points = (json['points'] as List? ?? const [])
        .whereType<Map>()
        .map((item) => LabTrendPoint.fromJson(Map<String, dynamic>.from(item)))
        .where((point) => point.value != null)
        .toList();

    return LabResultTrend(
      testCode: _clean(json['test_code']),
      loincCode: _clean(json['loinc_code']),
      testName: _clean(json['test_name']),
      unit: _clean(json['unit']),
      months: _asInt(json['months']),
      count: _asInt(json['count'], fallback: points.length),
      min: _asDouble(json['min']),
      max: _asDouble(json['max']),
      points: points,
    );
  }

  final String? testCode;
  final String? loincCode;
  final String? testName;
  final String? unit;
  final int months;
  final int count;
  final double? min;
  final double? max;
  final List<LabTrendPoint> points;

  List<double> get values =>
      points.map((point) => point.value).whereType<double>().toList();
}

class LabTrendPoint {
  const LabTrendPoint({
    required this.id,
    required this.at,
    required this.value,
    this.abnormalFlag,
    this.referenceRange,
  });

  factory LabTrendPoint.fromJson(Map<String, dynamic> json) {
    return LabTrendPoint(
      id: _asInt(json['id']),
      at: _parseDate(json['at']),
      value: _asDouble(json['value']),
      abnormalFlag: _clean(json['abnormal_flag']),
      referenceRange: _clean(json['reference_range']),
    );
  }

  final int id;
  final DateTime? at;
  final double? value;
  final String? abnormalFlag;
  final String? referenceRange;
}

String formatLabNumber(double value) {
  if (value == value.roundToDouble()) return value.toStringAsFixed(0);
  final oneDecimal = value.toStringAsFixed(1);
  if (double.parse(oneDecimal) == value) return oneDecimal;
  return value.toStringAsFixed(2);
}

String? _clean(dynamic value) {
  final text = value?.toString().trim();
  if (text == null || text.isEmpty) return null;
  return text;
}

int _asInt(dynamic value, {int fallback = 0}) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '') ?? fallback;
}

double? _asDouble(dynamic value) {
  if (value is double) return value;
  if (value is int) return value.toDouble();
  return double.tryParse(value?.toString() ?? '');
}

DateTime? _parseDate(dynamic value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString())?.toLocal();
}
