import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/bloodbank/transfusion_scan_intent.dart';

void main() {
  const patientUid = 'a1b2c3d4-0000-4000-8000-000000000001';

  test('matching transfusion scan builds an online-only request body', () {
    final intent = buildTransfusionScanIntent(
      requestId: 42,
      verifierRole: 'first',
      scannedPatientUid: patientUid,
      scannedUnitNumber: 'b4scan-001',
      expectedPatientUid: patientUid,
      expectedUnitNumber: 'B4SCAN-001',
    );

    expect(intent.hardStop, isFalse);
    expect(intent.submit, isTrue);
    expect(intent.body['verifier_role'], 'first');
    expect(intent.body['scanned_patient_uid'], patientUid);
    expect(intent.body['scanned_unit_number'], 'B4SCAN-001');
  });

  testWidgets('wrong unit barcode is a hard-stop and never submits', (
    tester,
  ) async {
    final intent = buildTransfusionScanIntent(
      requestId: 42,
      verifierRole: 'second',
      scannedPatientUid: patientUid,
      scannedUnitNumber: 'B4SCAN-WRONG',
      expectedPatientUid: patientUid,
      expectedUnitNumber: 'B4SCAN-001',
      overrideReason: 'Override entered by mistake',
    );

    expect(intent.hardStop, isTrue);
    expect(intent.submit, isFalse);
    expect(intent.failedRights, contains('unit'));
    expect(intent.body['override_reason'], 'Override entered by mistake');

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

  test('wrong-patient wristband is a hard-stop and never submits', () {
    final intent = buildTransfusionScanIntent(
      requestId: 42,
      verifierRole: 'first',
      scannedPatientUid: 'ffffffff-0000-4000-8000-000000000099',
      scannedUnitNumber: 'B4SCAN-001',
      expectedPatientUid: patientUid,
      expectedUnitNumber: 'B4SCAN-001',
    );

    expect(intent.hardStop, isTrue);
    expect(intent.submit, isFalse);
    expect(intent.failedRights, contains('patient'));
  });
}
