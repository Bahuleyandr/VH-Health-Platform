import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/prescription_payloads.dart';
import 'package:vhhealth_staff/features/doctor/prescription_offline_rx.dart';

void main() {
  final meds = [
    {'name': 'Paracetamol', 'strength': '500mg', 'frequency': 'BD'},
  ];

  OfflineRxIntent build(String deviceType) => buildOfflineRxIntent(
        deviceType: deviceType,
        patientId: 11,
        doctorId: 22,
        appointmentId: 33,
        diagnosis: 'Fever',
        clinicalNotes: 'rest',
        medications: meds,
        followUpDate: '2026-07-04',
        followUpNotes: 'review',
        vitals: {'temp': '101F'},
      );

  test('phone-mode (mobile) blocks — never enqueues', () {
    final i = build('mobile');
    expect(i.block, isTrue);
    expect(i.enqueue, isFalse);
    expect(i.reason, isNotNull);
  });

  test('empty / unknown deviceType blocks (fail-closed)', () {
    expect(build('').block, isTrue);
    expect(build('   ').block, isTrue);
  });

  test('tablet enqueues with the /prescriptions/create endpoint', () {
    final i = build('tablet');
    expect(i.block, isFalse);
    expect(i.enqueue, isTrue);
    expect(i.endpoint, '/prescriptions/create');
    expect(i.reason, isNull);
  });

  test('desktop enqueues', () {
    expect(build('desktop').enqueue, isTrue);
  });

  test('queued body equals the online builder output (no override offline)', () {
    final i = build('tablet');
    final online = buildPrescriptionBody(
      patientId: 11,
      doctorId: 22,
      appointmentId: 33,
      diagnosis: 'Fever',
      clinicalNotes: 'rest',
      medications: meds,
      followUpDate: '2026-07-04',
      followUpNotes: 'review',
      vitals: {'temp': '101F'},
    );
    expect(i.body, online);
    expect(i.body.containsKey('override'), isFalse);
  });
}
