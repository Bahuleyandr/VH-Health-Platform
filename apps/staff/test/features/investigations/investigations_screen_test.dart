import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/features/investigations/screens/investigations_screen.dart';

void main() {
  group('investigations role actions', () {
    test('hides result upload for doctor-style roles', () {
      expect(investigationsCanUploadResultsForRole(StaffRole.doctor), isFalse);
      expect(
        investigationsCanUploadResultsForRole(StaffRole.dutyDoctor),
        isFalse,
      );
      expect(
        investigationsCanUploadResultsForRole(StaffRole.anaesthetist),
        isFalse,
      );
    });

    test('keeps result upload available to lab and admin teams', () {
      expect(investigationsCanUploadResultsForRole(StaffRole.lab), isTrue);
      expect(
        investigationsCanUploadResultsForRole(StaffRole.radiologyStaff),
        isTrue,
      );
      expect(investigationsCanUploadResultsForRole(StaffRole.admin), isTrue);
      expect(
        investigationsCanUploadResultsForRole(StaffRole.superAdmin),
        isTrue,
      );
    });

    test('keeps pending status workflow away from doctor roles', () {
      expect(
        investigationsCanManagePendingStatusForRole(StaffRole.doctor),
        isFalse,
      );
      expect(
        investigationsCanManagePendingStatusForRole(StaffRole.dutyDoctor),
        isFalse,
      );
      expect(
        investigationsCanManagePendingStatusForRole(StaffRole.anaesthetist),
        isFalse,
      );
    });

    test('allows lab, radiology, and admin teams to progress pending status', () {
      expect(investigationsCanManagePendingStatusForRole(StaffRole.lab), isTrue);
      expect(
        investigationsCanManagePendingStatusForRole(StaffRole.radiologyStaff),
        isTrue,
      );
      expect(
        investigationsCanManagePendingStatusForRole(StaffRole.admin),
        isTrue,
      );
      expect(
        investigationsCanManagePendingStatusForRole(StaffRole.superAdmin),
        isTrue,
      );
    });
  });

  group('investigation patient context matching', () {
    test('accepts exact Indian country-code equivalents only', () {
      expect(investigationPhoneMatches('+911234567890', '1234567890'), isTrue);
      expect(investigationPhoneMatches('1234567890', '+911234567890'), isTrue);
      expect(investigationPhoneMatches('1123456789', '+911234567890'), isFalse);
      expect(investigationPhoneMatches('1234566789', '123456789'), isFalse);
    });
  });
}
