import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
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

    test('keeps bulk prior-record upload titles distinguishable', () {
      expect(
        patientRecordsUploadTitleForFile(
          baseTitle: 'Outside records',
          fileName: 'scan-2024.pdf',
          fileCount: 1,
        ),
        'Outside records',
      );
      expect(
        patientRecordsUploadTitleForFile(
          baseTitle: 'Outside records',
          fileName: 'scan-2024.pdf',
          fileCount: 3,
        ),
        'Outside records - scan-2024',
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

    test('hides prior-record upload for doctor-style roles', () {
      expect(
        patientRecordsCanUploadPriorRecordsForRole(StaffRole.doctor),
        isFalse,
      );
      expect(
        patientRecordsCanUploadPriorRecordsForRole(StaffRole.dutyDoctor),
        isFalse,
      );
      expect(
        patientRecordsCanUploadPriorRecordsForRole(StaffRole.anaesthetist),
        isFalse,
      );
      expect(patientRecordsCanUploadPriorRecordsForRole(StaffRole.lab), isTrue);
      expect(
        patientRecordsCanUploadPriorRecordsForRole(StaffRole.receptionist),
        isTrue,
      );
    });

    test(
      'adapts canonical timeline prescriptions into patient record rows',
      () {
        final records = patientRecordsFromTimelineResponse(
          {
            'data': [
              {
                'id': 'signed-1',
                'event_type': 'prescription.signed',
                'event_status': 'signed',
                'resource_type': 'prescription',
                'resource_id': '63',
                'occurred_at': '2026-06-08T14:31:22.652Z',
                'clinical_summary': 'Prescription RX-123 signed',
                'payload': {'prescription_number': 'RX-123'},
              },
              {
                'id': 'created-1',
                'event_type': 'prescription.created',
                'event_status': 'draft',
                'resource_type': 'prescription',
                'resource_id': '63',
                'occurred_at': '2026-06-08T14:31:17.236Z',
                'clinical_summary': 'Prescription RX-123 created',
                'payload': {'diagnosis': 'CAD - UA'},
              },
            ],
          },
          patient: {'name': 'test'},
        );

        expect(records, hasLength(1));
        expect(records.single['record_type'], 'OP Prescription');
        expect(records.single['status'], 'signed');
        expect(records.single['patientName'], 'test');
        expect(records.single['summary'], contains('Prescription RX-123'));
      },
    );

    test('keeps OP note and investigation timeline events visible', () {
      final note = patientRecordFromTimelineEvent({
        'event_type': 'note.created',
        'event_subtype': 'op_consultation',
        'event_status': 'draft',
        'resource_type': 'clinical_note',
        'resource_id': '104',
        'title': 'OP consultation - test',
        'clinical_summary': 'CC: Chest pain | Dx: CAD',
      });
      final investigation = patientRecordFromTimelineEvent({
        'event_type': 'investigation.ordered',
        'event_status': 'REQUESTED',
        'resource_type': 'investigation',
        'resource_id': '176',
        'clinical_summary': 'ECG ordered',
        'payload': {'test_name': 'ECG', 'test_type': 'LAB'},
      });
      final edited = patientRecordFromTimelineEvent({
        'event_type': 'note.edited',
        'resource_type': 'clinical_note',
        'resource_id': '104',
      });

      expect(note?['record_type'], 'Clinical Note');
      expect(note?['title'], 'OP consultation - test');
      expect(investigation?['record_type'], 'Investigation');
      expect(investigation?['title'], 'Investigation - ECG');
      expect(edited, isNull);
    });
  });
}
