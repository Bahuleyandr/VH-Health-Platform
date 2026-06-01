import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/emr/screens/vitals_chart_screen.dart';

void main() {
  test('records consciousness with ACVPU option order', () {
    expect(vitalsConsciousnessOptionCodes, ['A', 'C', 'V', 'P', 'U']);
  });

  group('normalizeVitalsConsciousness', () {
    test('keeps backend AVPU consciousness codes unchanged', () {
      expect(normalizeVitalsConsciousness('A'), 'A');
      expect(normalizeVitalsConsciousness('C'), 'C');
      expect(normalizeVitalsConsciousness('V'), 'V');
      expect(normalizeVitalsConsciousness('P'), 'P');
      expect(normalizeVitalsConsciousness('U'), 'U');
    });

    test('converts legacy UI labels to backend consciousness codes', () {
      expect(normalizeVitalsConsciousness('Alert'), 'A');
      expect(normalizeVitalsConsciousness('Confused'), 'C');
      expect(normalizeVitalsConsciousness('Verbal'), 'V');
      expect(normalizeVitalsConsciousness('Responds to Voice'), 'V');
      expect(normalizeVitalsConsciousness('Pain'), 'P');
      expect(normalizeVitalsConsciousness('Responds to Pain'), 'P');
      expect(normalizeVitalsConsciousness('Unresponsive'), 'U');
    });

    test('accepts display labels prefixed with a consciousness code', () {
      expect(normalizeVitalsConsciousness('A - Alert'), 'A');
      expect(normalizeVitalsConsciousness('V - Responds to Voice'), 'V');
    });
  });

  group('buildVitalsRecordPayload', () {
    test('uses backend EMR vitals field names', () {
      final payload = buildVitalsRecordPayload(
        patientUid: 'PAT-1',
        hr: '82 /min',
        bpSystolic: '120 mm Hg',
        bpDiastolic: '78 mm Hg',
        temp: '98.6 deg F',
        spo2: '98%',
        rr: '18 /min',
        glucose: '110 mg/dl',
        pain: '2 /10',
        gcs: '15 /15',
        consciousness: 'Alert',
      );

      expect(payload['patient_uid'], 'PAT-1');
      expect(payload['heart_rate'], 82);
      expect(payload['systolic_bp'], 120);
      expect(payload['diastolic_bp'], 78);
      expect(payload['temperature'], 98.6);
      expect(payload['spo2'], 98);
      expect(payload['respiratory_rate'], 18);
      expect(payload['blood_glucose'], 110);
      expect(payload['pain_score'], 2);
      expect(payload['gcs_score'], 15);
      expect(payload['consciousness'], 'A');

      expect(payload.containsKey('bp_systolic'), isFalse);
      expect(payload.containsKey('bp_diastolic'), isFalse);
      expect(payload.containsKey('glucose'), isFalse);
      expect(payload.containsKey('gcs'), isFalse);
    });
  });
}
