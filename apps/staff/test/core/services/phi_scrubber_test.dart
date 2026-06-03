import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/phi_scrubber.dart';

void main() {
  group('PhiScrubber', () {
    test('redacts common PHI and secrets from text', () {
      final value = PhiScrubber.scrubText(
        'Patient VH-000097 phone +911234567890 email test@example.com '
        'token eyJabc.def.ghi uuid a1f04cf1-3f2a-4a85-a2d3-7fd06c928017',
      );

      expect(value, contains('[REDACTED_PATIENT_ID]'));
      expect(value, contains('[REDACTED_PHONE]'));
      expect(value, contains('[REDACTED_EMAIL]'));
      expect(value, contains('[REDACTED_TOKEN]'));
      expect(value, contains('[REDACTED_ID]'));
      expect(value, isNot(contains('1234567890')));
      expect(value, isNot(contains('test@example.com')));
    });

    test('normalizes patient and record identifiers in paths', () {
      expect(
        PhiScrubber.normalizePath(
          'https://api.vhhealth.app/api/v1/patients/123456/timeline?date=1',
        ),
        '/api/v1/patients/:id/timeline',
      );
      expect(
        PhiScrubber.normalizePath(
          '/api/v1/emr/vitals/a1f04cf1-3f2a-4a85-a2d3-7fd06c928017',
        ),
        '/api/v1/emr/vitals/:uuid',
      );
    });

    test('scrubs sensitive map keys recursively', () {
      final value = PhiScrubber.scrubMap({
        'role': 'NURSE',
        'patientName': 'Priya Iyer',
        'headers': {'Authorization': 'Bearer secret'},
      });

      expect(value['role'], 'NURSE');
      expect(value['patientName'], '[REDACTED]');
      expect((value['headers'] as Map)['Authorization'], '[REDACTED]');
    });
  });
}
