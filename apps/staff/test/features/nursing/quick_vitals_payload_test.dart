// Quick-vitals → POST /health/records payload contract (P3 hygiene 2026-08).
//
// The quick-vitals form collects temperature in Fahrenheit while the backend
// stores canonical Celsius. POST /health/records happens to default a
// unitless temperature to 'F', but the cross-repo contract is that °F
// senders declare the unit explicitly (the EMR record sheet already does via
// vitalsTemperatureUnitSent). These tests pin the wire payload.
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/nursing/screens/vitals_screen.dart';

void main() {
  group('buildQuickVitalsPayload', () {
    test('declares temperature_unit F whenever temperature is present', () {
      final payload = buildQuickVitalsPayload(
        bpSystolic: '120',
        bpDiastolic: '80',
        temperature: '98.6',
        pulse: '72',
        spo2: '97',
        weight: '70',
      );

      expect(payload.vitalSigns, {
        'blood_pressure': {'systolic': 120, 'diastolic': 80},
        'temperature': 98.6,
        'temperature_unit': 'F',
        'pulse': 72,
        'spo2': 97.0,
      });
      expect(payload.measurements, {'weight': 70.0});
      expect(quickVitalsTemperatureUnitSent, 'F');
    });

    test('omits the unit (and temperature) when no temperature is entered', () {
      final payload = buildQuickVitalsPayload(
        bpSystolic: '120',
        bpDiastolic: '80',
        temperature: '',
        pulse: '72',
        spo2: '',
        weight: '',
      );

      expect(payload.vitalSigns.containsKey('temperature'), isFalse);
      expect(payload.vitalSigns.containsKey('temperature_unit'), isFalse);
      expect(payload.vitalSigns, {
        'blood_pressure': {'systolic': 120, 'diastolic': 80},
        'pulse': 72,
      });
      expect(payload.measurements, isEmpty);
    });

    test(
      'strips display units before parsing, matching the old inline build',
      () {
        // VitalUnit-suffixed input (e.g. from dictation) still normalizes.
        final payload = buildQuickVitalsPayload(
          bpSystolic: '',
          bpDiastolic: '',
          temperature: ' 99.1 ',
          pulse: '',
          spo2: '',
          weight: '',
        );
        expect(payload.vitalSigns['temperature'], 99.1);
        expect(payload.vitalSigns['temperature_unit'], 'F');
        expect(payload.vitalSigns.containsKey('blood_pressure'), isFalse);
      },
    );
  });
}
