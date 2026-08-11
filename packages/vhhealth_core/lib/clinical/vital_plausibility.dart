import 'vital_plausibility_bounds.g.dart';

export 'vital_plausibility_bounds.g.dart';

enum VitalPlausibilityIssue { notANumber, outOfRange }

VitalPlausibilityBound vitalPlausibilityBoundFor(
  String field, {
  bool fahrenheit = false,
}) {
  final source =
      vitalPlausibilityBounds[field] ?? icuFlowsheetPlausibilityBounds[field];
  if (source == null) {
    throw ArgumentError.value(field, 'field', 'Unknown vital field');
  }
  if (!fahrenheit) return source;
  if (field != 'temperature') {
    throw ArgumentError.value(
      field,
      'field',
      'Fahrenheit conversion is valid only for temperature',
    );
  }
  return VitalPlausibilityBound(
    min: source.min * 9 / 5 + 32,
    max: source.max * 9 / 5 + 32,
    unit: 'deg F',
    integer: false,
  );
}

VitalPlausibilityIssue? vitalPlausibilityIssue(
  String normalizedValue,
  String field, {
  bool? integer,
  bool fahrenheit = false,
}) {
  final text = normalizedValue.trim();
  if (text.isEmpty) return null;
  final bounds = vitalPlausibilityBoundFor(field, fahrenheit: fahrenheit);
  final requiresInteger = integer ?? bounds.integer;
  final num? value = requiresInteger ? int.tryParse(text) : num.tryParse(text);
  if (value == null) return VitalPlausibilityIssue.notANumber;
  if (value < bounds.min || value > bounds.max) {
    return VitalPlausibilityIssue.outOfRange;
  }
  return null;
}
