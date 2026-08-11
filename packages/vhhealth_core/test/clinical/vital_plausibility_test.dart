import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/clinical/vital_plausibility.dart';

void main() {
  test(
    'generated client contract admits peri-arrest core vitals and MAP 0',
    () {
      for (final field in [
        'heart_rate',
        'systolic_bp',
        'diastolic_bp',
        'map',
      ]) {
        expect(vitalPlausibilityIssue('0', field, integer: true), isNull);
      }
      expect(vitalPlausibilityIssue('0', 'spo2'), isNull);
      expect(vitalPlausibilityIssue('120', 'respiratory_rate'), isNull);
      expect(vitalPlausibilityIssue('0', 'blood_glucose'), isNull);
    },
  );

  test('Fahrenheit forms derive their temperature envelope from Celsius', () {
    final bounds = vitalPlausibilityBoundFor('temperature', fahrenheit: true);
    expect(bounds.min, closeTo(53.6, 0.0001));
    expect(bounds.max, 113);
    expect(
      vitalPlausibilityIssue('53.6', 'temperature', fahrenheit: true),
      isNull,
    );
    expect(
      vitalPlausibilityIssue('53.5', 'temperature', fahrenheit: true),
      VitalPlausibilityIssue.outOfRange,
    );
  });

  test('impossible values and the preserved upper bounds still reject', () {
    expect(
      vitalPlausibilityIssue('-1', 'heart_rate', integer: true),
      VitalPlausibilityIssue.outOfRange,
    );
    expect(
      vitalPlausibilityIssue('301', 'heart_rate', integer: true),
      VitalPlausibilityIssue.outOfRange,
    );
    expect(
      vitalPlausibilityIssue('101', 'spo2'),
      VitalPlausibilityIssue.outOfRange,
    );
    expect(vitalPlausibilitySourceSha256, hasLength(64));
  });
}
