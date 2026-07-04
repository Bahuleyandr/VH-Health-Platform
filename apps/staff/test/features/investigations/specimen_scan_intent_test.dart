import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/investigations/specimen_scan_intent.dart';

void main() {
  const patientUid = 'a1b2c3d4-0000-4000-8000-000000000001';

  test('matching specimen scan builds a collect-sample request', () {
    final intent = buildSpecimenScanIntent(
      investigationId: 77,
      scannedPatientUid: patientUid,
      tubeBarcode: 'tube-0007',
      expectedPatientUid: patientUid,
      notes: 'Collected at bedside',
    );

    expect(intent.hardStop, isFalse);
    expect(intent.submit, isTrue);
    expect(intent.enqueue, isTrue);
    expect(intent.endpoint, '/lab/samples/77/collect');
    expect(intent.body['scanned_patient_uid'], patientUid);
    expect(intent.body['sample_barcode'], 'tube-0007');
    expect(intent.body['collected_notes'], 'Collected at bedside');
  });

  testWidgets('wrong-patient wristband is a hard-stop and never submits', (
    tester,
  ) async {
    final intent = buildSpecimenScanIntent(
      investigationId: 77,
      scannedPatientUid: 'ffffffff-0000-4000-8000-000000000099',
      tubeBarcode: 'tube-0007',
      expectedPatientUid: patientUid,
      notes: 'Override entered by mistake',
    );

    expect(intent.hardStop, isTrue);
    expect(intent.submit, isFalse);
    expect(intent.enqueue, isFalse);
    expect(intent.failedRights, contains('patient'));

    await tester.pumpWidget(
      MaterialApp(
        home: ElevatedButton(
          onPressed: intent.submit ? () {} : null,
          child: const Text('Proceed'),
        ),
      ),
    );
    final button = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
    expect(button.onPressed, isNull);
  });

  test('blank tube barcode does not enqueue', () {
    final intent = buildSpecimenScanIntent(
      investigationId: 77,
      scannedPatientUid: patientUid,
      tubeBarcode: '   ',
      expectedPatientUid: patientUid,
    );

    expect(intent.hardStop, isFalse);
    expect(intent.submit, isFalse);
    expect(intent.enqueue, isFalse);
  });
}
