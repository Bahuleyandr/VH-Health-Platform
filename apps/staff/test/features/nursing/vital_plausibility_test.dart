import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/clinical/vital_plausibility.dart';
import 'package:vhhealth_staff/core/widgets/vital_text_field.dart';
import 'package:vhhealth_staff/features/nursing/screens/vitals_screen.dart';

void main() {
  test(
    'quick vitals accepts peri-arrest values from the generated contract',
    () {
      expect(
        quickVitalsFieldIssue('0', 'systolic_bp', VitalUnit.bp, integer: true),
        isNull,
      );
      expect(
        quickVitalsFieldIssue('0', 'diastolic_bp', VitalUnit.bp, integer: true),
        isNull,
      );
      expect(
        quickVitalsFieldIssue(
          '0',
          'heart_rate',
          VitalUnit.pulse,
          integer: true,
        ),
        isNull,
      );
      expect(
        quickVitalsFieldIssue('0', 'spo2', VitalUnit.spo2, integer: false),
        isNull,
      );
      expect(
        quickVitalsFieldIssue(
          '53.6',
          'temperature',
          VitalUnit.temperature,
          integer: false,
          fahrenheit: true,
        ),
        isNull,
      );
    },
  );

  test('quick vitals still rejects impossible values and malformed input', () {
    expect(
      quickVitalsFieldIssue('-1', 'heart_rate', VitalUnit.pulse, integer: true),
      VitalPlausibilityIssue.outOfRange,
    );
    expect(
      quickVitalsFieldIssue(
        '301',
        'heart_rate',
        VitalUnit.pulse,
        integer: true,
      ),
      VitalPlausibilityIssue.outOfRange,
    );
    expect(
      quickVitalsFieldIssue(
        'not-a-number',
        'spo2',
        VitalUnit.spo2,
        integer: false,
      ),
      VitalPlausibilityIssue.notANumber,
    );
  });
}
