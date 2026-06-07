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
  });
}
