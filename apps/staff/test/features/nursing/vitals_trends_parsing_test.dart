// Pins the nursing Trends-tab response contract (finding F2):
// GET /health/patient/:id/trends returns camelCase vital_signs
// ({bloodPressure, heartRate, temperature, bloodSugar, spO2} —
// patientHealthService.formatVitalRecord), which the tab previously read
// with snake/short keys, so the BP/pulse/SpO2 chips never rendered. The
// normalizer must accept BOTH spellings, and the temperature (canonical °C
// in patient_vitals) must convert to °F before it is labelled
// VitalUnit.temperature ('deg F').
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/nursing/screens/vitals_screen.dart';

void main() {
  group('normalizeTrendVitalSigns', () {
    test('parses the live camelCase backend shape', () {
      final vitals = normalizeTrendVitalSigns({
        'id': 1,
        'vital_signs': {
          'bloodPressure': {'systolic': 120, 'diastolic': 80},
          'heartRate': 82,
          'temperature': 37.2,
          'bloodSugar': 110,
          'spO2': 98,
        },
      });
      expect(vitals['blood_pressure'], {'systolic': 120, 'diastolic': 80});
      expect(vitals['pulse'], 82);
      expect(vitals['temperature'], 37.2);
      expect(vitals['blood_sugar'], 110);
      expect(vitals['spo2'], 98);
    });

    test('still tolerates the legacy snake/short-key shape', () {
      final vitals = normalizeTrendVitalSigns({
        'vital_signs': {
          'blood_pressure': {'systolic': 118, 'diastolic': 76},
          'pulse': 74,
          'temperature': 36.8,
          'blood_sugar': 95,
          'spo2': 99,
        },
      });
      expect(vitals['blood_pressure'], {'systolic': 118, 'diastolic': 76});
      expect(vitals['pulse'], 74);
      expect(vitals['blood_sugar'], 95);
      expect(vitals['spo2'], 99);
    });

    test('camelCase wins when both spellings are present', () {
      final vitals = normalizeTrendVitalSigns({
        'vital_signs': {'heartRate': 82, 'pulse': 60, 'spO2': 98, 'spo2': 90},
      });
      expect(vitals['pulse'], 82);
      expect(vitals['spo2'], 98);
    });

    test('missing / malformed vital_signs yields all-null values', () {
      for (final record in [
        <String, dynamic>{},
        <String, dynamic>{'vital_signs': null},
        <String, dynamic>{'vital_signs': 'oops'},
      ]) {
        final vitals = normalizeTrendVitalSigns(record);
        expect(vitals['blood_pressure'], isNull);
        expect(vitals['pulse'], isNull);
        expect(vitals['temperature'], isNull);
        expect(vitals['spo2'], isNull);
      }
    });
  });

  group('trendTemperatureDisplay', () {
    test('converts canonical °C to the °F string the deg-F label needs', () {
      expect(trendTemperatureDisplay(37.2), '99.0');
      expect(trendTemperatureDisplay(37.0), '98.6');
      expect(trendTemperatureDisplay('36.5'), '97.7');
    });

    test('non-numeric input returns null (caller falls back to raw text)', () {
      expect(trendTemperatureDisplay(null), isNull);
      expect(trendTemperatureDisplay('n/a'), isNull);
    });
  });
}
