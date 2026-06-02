import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/doctor/screens/patient_records_screen.dart';

void main() {
  group('patient records front-office prefill', () {
    test('parses patient id query safely', () {
      expect(patientRecordsPatientIdFromQuery('18'), 18);
      expect(patientRecordsPatientIdFromQuery('0'), isNull);
      expect(patientRecordsPatientIdFromQuery('VH-000018'), isNull);
      expect(patientRecordsPatientIdFromQuery(null), isNull);
    });

    test('uses last 10 digits for phone fallback lookup', () {
      expect(patientRecordsPhoneSearchDigits('+91 12345 67890'), '1234567890');
      expect(patientRecordsPhoneSearchDigits('1234567890'), '1234567890');
      expect(patientRecordsPhoneSearchDigits('123456789'), '');
    });

    test('builds a readable initial patient search label', () {
      expect(
        patientRecordsInitialSearchText(
          hospitalNumber: 'VH-000018',
          name: 'Test Patient',
          phone: '+911234567890',
        ),
        'VH-000018 - Test Patient - +911234567890',
      );
      expect(
        patientRecordsInitialSearchText(name: 'Test Patient'),
        'Test Patient',
      );
    });

    test('detects scoped upload patient context', () {
      expect(patientRecordsHasScopedUploadPatient(patientId: '18'), isTrue);
      expect(
        patientRecordsHasScopedUploadPatient(phone: '+91 12345 67890'),
        isTrue,
      );
      expect(patientRecordsHasScopedUploadPatient(phone: '123456789'), isFalse);
    });

    test('uses selected-patient upload helper text when scoped', () {
      expect(
        patientRecordsUploadLookupMessage(hasScopedPatient: true),
        'Using selected patient from Patient Records',
      );
      expect(
        patientRecordsUploadLookupMessage(hasScopedPatient: false),
        'Enter phone, then tap Check',
      );
    });

    test('reads nested AI extraction state from patient records', () {
      final extraction = patientRecordAiExtractionFrom({
        'id': '42',
        'ai_extraction': {
          'intake_id': 9,
          'extraction_status': 'completed',
          'reviewer_decision': 'pending',
        },
      });

      expect(extraction?['intake_id'], 9);
      expect(
        patientRecordHasReviewableAiDraft({'ai_extraction': extraction}),
        isTrue,
      );
      expect(patientRecordAiReviewLabel(extraction), 'Review AI draft');
    });

    test('labels reviewed and unavailable AI extraction states', () {
      expect(
        patientRecordAiReviewLabel({
          'intake_id': 1,
          'extraction_status': 'completed',
          'reviewer_decision': 'accepted',
        }),
        'AI confirmed',
      );
      expect(
        patientRecordAiReviewLabel({
          'extraction_status': 'unavailable',
          'reviewer_decision': 'pending',
        }),
        'AI unavailable',
      );
      expect(
        patientRecordHasReviewableAiDraft({
          'ai_extraction': {
            'intake_id': null,
            'extraction_status': 'unavailable',
          },
        }),
        isFalse,
      );
    });
  });
}
