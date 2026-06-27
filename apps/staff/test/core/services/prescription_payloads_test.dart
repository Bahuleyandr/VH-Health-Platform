import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/prescription_payloads.dart';

void main() {
  final meds = [
    {'name': 'Paracetamol', 'strength': '500mg', 'frequency': 'BD'},
    {'name': 'Amoxicillin', 'strength': '500mg', 'frequency': 'TDS'},
  ];

  test('builds the canonical prescription body with the full field set', () {
    final body = buildPrescriptionBody(
      patientId: 11,
      doctorId: 22,
      appointmentId: 33,
      diagnosis: 'Fever',
      clinicalNotes: 'rest + fluids',
      medications: meds,
      followUpDate: '2026-07-04',
      followUpNotes: 'review CBC',
      override: {'reason': 'attending cleared the allergy flag'},
      vitals: {'temp': '101F'},
    );
    expect(body['patient_id'], 11);
    expect(body['doctor_id'], 22);
    expect(body['appointment_id'], 33);
    expect(body['diagnosis'], 'Fever');
    expect(body['clinical_notes'], 'rest + fluids');
    expect(body['medications'], meds);
    expect((body['medications'] as List).length, 2);
    expect(body['follow_up_date'], '2026-07-04');
    expect(body['follow_up_notes'], 'review CBC');
    expect(body['override'], {'reason': 'attending cleared the allergy flag'});
    expect(body['vitals'], {'temp': '101F'});
    expect(body.containsKey('admission_id'), isFalse);
    expect(body.containsKey('visit_type'), isFalse);
  });

  test('omits optionals; clinical_notes key present-but-null; diagnosis present-when-empty', () {
    final body = buildPrescriptionBody(
      patientId: 1, doctorId: 2, diagnosis: '', clinicalNotes: null, medications: meds,
    );
    expect(body.containsKey('appointment_id'), isFalse);
    expect(body['diagnosis'], '');
    expect(body.containsKey('clinical_notes'), isTrue);
    expect(body['clinical_notes'], isNull);
    expect(body.containsKey('follow_up_date'), isFalse);
    expect(body.containsKey('follow_up_notes'), isFalse);
    expect(body.containsKey('override'), isFalse);
    expect(body.containsKey('vitals'), isFalse);
  });

  test('omits follow_up_notes when empty string', () {
    final body = buildPrescriptionBody(
      patientId: 1, doctorId: 2, diagnosis: 'x', medications: meds, followUpNotes: '',
    );
    expect(body.containsKey('follow_up_notes'), isFalse);
  });
}
