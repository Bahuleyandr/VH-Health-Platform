import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/bloodbank/models/blood_request.dart';

void main() {
  test('maps a curated patient result into a request patient', () {
    final patient = BloodRequestPatient.fromSearchResult(const {
      'uid': 'a9999999-9999-4999-8999-999999999a03',
      'name': 'Blood Test Patient',
      'hospital_number': 'VH-000018',
    });

    expect(patient, isNotNull);
    expect(patient!.uid, 'a9999999-9999-4999-8999-999999999a03');
    expect(patient.name, 'Blood Test Patient');
    expect(patient.hospitalNumber, 'VH-000018');
  });

  test('rejects a patient result without a backend UUID', () {
    expect(
      BloodRequestPatient.fromSearchResult(const {
        'uid': 'patient-18',
        'name': 'Invalid Patient',
      }),
      isNull,
    );
  });

  test('serializes only the canonical backend request contract', () {
    const payload = BloodRequestPayload(
      patientUid: 'a9999999-9999-4999-8999-999999999a03',
      bloodGroup: 'O+',
      units: 2,
      component: BloodComponent.packedRedBloodCells,
      clinicalIndication: 'Elective surgery, Hb 7.1',
      urgency: BloodUrgency.urgent,
    );

    expect(payload.toJson(), {
      'patient_uid': 'a9999999-9999-4999-8999-999999999a03',
      'blood_group': 'O+',
      'units': 2,
      'component': 'prbc',
      'clinical_indication': 'Elective surgery, Hb 7.1',
      'urgency': 'urgent',
    });
    expect(payload.toJson(), isNot(contains('patientName')));
    expect(payload.toJson(), isNot(contains('bloodType')));
    expect(payload.toJson(), isNot(contains('reason')));
  });
}
