import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/core/platform_info.dart';
import 'package:vhhealth_staff/features/reception/screens/front_office_workbench_screen.dart';

void main() {
  group('frontOfficeWorkbenchCanLoad', () {
    test(
      'allows front-office roles only on tablet or desktop workbench modes',
      () {
        expect(
          frontOfficeWorkbenchCanLoad(
            role: StaffRole.receptionist,
            mode: AppDeviceMode.desktop,
          ),
          isTrue,
        );
        expect(
          frontOfficeWorkbenchCanLoad(
            role: StaffRole.billingStaff,
            mode: AppDeviceMode.tablet,
          ),
          isTrue,
        );
        expect(
          frontOfficeWorkbenchCanLoad(
            role: StaffRole.receptionist,
            mode: AppDeviceMode.mobile,
          ),
          isFalse,
        );
        expect(
          frontOfficeWorkbenchCanLoad(
            role: StaffRole.housekeeping,
            mode: AppDeviceMode.desktop,
          ),
          isFalse,
        );
      },
    );
  });

  group('frontOfficeAdmissionTotalFrom', () {
    test('uses backend pagination total instead of loaded preview length', () {
      final total = frontOfficeAdmissionTotalFrom({
        'admissions': List.generate(12, (index) => {'id': index + 1}),
        'pagination': {'total': 46, 'limit': 12},
      }, fallbackCount: 12);

      expect(total, 46);
    });

    test('accepts legacy totalItems and string totals', () {
      expect(
        frontOfficeAdmissionTotalFrom({
          'admissions': const [],
          'pagination': {'totalItems': '31'},
        }, fallbackCount: 0),
        31,
      );
    });

    test('falls back to loaded count when no total is present', () {
      expect(
        frontOfficeAdmissionTotalFrom({
          'admissions': const [],
        }, fallbackCount: 5),
        5,
      );
    });
  });
}
