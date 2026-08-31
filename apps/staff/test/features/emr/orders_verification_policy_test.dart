import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/platform_info.dart';
import 'package:vhhealth_staff/features/emr/screens/orders_screen.dart';

void main() {
  test('only inpatient nursing and pharmacy roles can verify orders', () {
    for (final role in const [
      'NURSING_STAFF',
      'NURSING_INCHARGE',
      'IP_STAFF_NURSE',
      'IP_INCHARGE',
      'ICU_NURSE',
      'ICU_INCHARGE',
      'PHARMACY_STAFF',
      'PHARMACY_INCHARGE',
      'PHARMACIST',
    ]) {
      expect(canVerifyMedicationOrders(role), isTrue, reason: role);
      expect(
        canRunMedicationOrderVerification(role, AppDeviceMode.desktop),
        isTrue,
        reason: role,
      );
      expect(
        canRunMedicationOrderVerification(role, AppDeviceMode.tablet),
        isTrue,
        reason: role,
      );
      expect(
        canRunMedicationOrderVerification(role, AppDeviceMode.mobile),
        isFalse,
        reason: role,
      );
    }
  });

  test(
    'prescribers and broad administrative roles do not see verification',
    () {
      for (final role in const [
        'DOCTOR',
        'DUTY_DOCTOR',
        'ADMIN',
        'SUPER_ADMIN',
        'OP_STAFF_NURSE',
        'CNO',
        'ICU_STAFF',
        'LAB_STAFF',
        'PATIENT',
        '',
      ]) {
        expect(canVerifyMedicationOrders(role), isFalse, reason: role);
      }
      expect(canVerifyMedicationOrders(null), isFalse);
    },
  );

  test('role matching is normalized without broad aliases', () {
    expect(canVerifyMedicationOrders(' pharmacy_staff '), isTrue);
    expect(canVerifyMedicationOrders('Ip_Staff_Nurse'), isTrue);
    expect(canVerifyMedicationOrders('NURSE'), isFalse);
    expect(canVerifyMedicationOrders('PHARMACY'), isFalse);
  });

  test(
    'pharmacy visibility is medication-only while nursing remains generic',
    () {
      for (final role in const [
        'PHARMACY_STAFF',
        'PHARMACY_INCHARGE',
        'PHARMACIST',
      ]) {
        expect(
          canRunClinicalOrderVerification(
            role,
            AppDeviceMode.desktop,
            'medication',
          ),
          isTrue,
          reason: role,
        );
        for (final type in const [
          'investigation',
          'radiology',
          'procedure',
          'diet',
          'nursing',
        ]) {
          expect(
            canRunClinicalOrderVerification(role, AppDeviceMode.desktop, type),
            isFalse,
            reason: '$role / $type',
          );
        }
      }

      expect(
        canRunClinicalOrderVerification(
          'IP_STAFF_NURSE',
          AppDeviceMode.desktop,
          'investigation',
        ),
        isTrue,
      );
      expect(
        canRunClinicalOrderVerification(
          'IP_STAFF_NURSE',
          AppDeviceMode.mobile,
          'investigation',
        ),
        isFalse,
      );
      expect(
        canRunClinicalOrderVerification(
          'IP_STAFF_NURSE',
          AppDeviceMode.desktop,
          null,
        ),
        isFalse,
      );
    },
  );
}
