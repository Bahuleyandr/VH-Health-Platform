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

  group('frontOfficeWorkbenchShouldRequestWorklists', () {
    test('loads tablet workbench data from the resolved screen mode', () {
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.receptionist,
          mode: AppDeviceMode.tablet,
          loadedForMode: null,
          loadInFlight: false,
        ),
        isTrue,
      );
    });

    test('does not load for phone mode or unsupported roles', () {
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.receptionist,
          mode: AppDeviceMode.mobile,
          loadedForMode: null,
          loadInFlight: false,
        ),
        isFalse,
      );
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.housekeeping,
          mode: AppDeviceMode.desktop,
          loadedForMode: null,
          loadInFlight: false,
        ),
        isFalse,
      );
    });

    test('avoids duplicate loads unless the user refreshes', () {
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.receptionist,
          mode: AppDeviceMode.desktop,
          loadedForMode: AppDeviceMode.desktop,
          loadInFlight: false,
        ),
        isFalse,
      );
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.receptionist,
          mode: AppDeviceMode.desktop,
          loadedForMode: AppDeviceMode.desktop,
          loadInFlight: false,
          force: true,
        ),
        isTrue,
      );
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.receptionist,
          mode: AppDeviceMode.desktop,
          loadedForMode: null,
          loadInFlight: true,
        ),
        isFalse,
      );
    });
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

  group('front-office OPD to IPD admission advice mapping', () {
    test('uses the advised appointment id as the admission advice id', () {
      expect(
        frontOfficeAdmissionAdviceIdFrom({
          'id': 410,
          'patient_id': 22,
          'advised_for_admission_at': '2026-06-01T09:30:00.000Z',
        }),
        410,
      );
      expect(frontOfficeAdmissionAdviceIdFrom({'appointment_id': '411'}), 411);
      expect(
        frontOfficeAdmissionAdviceIdFrom({'admission_advice_id': '412'}),
        412,
      );
    });

    test('maps flat appointment rows into patient selection data', () {
      final patient = frontOfficeAdmissionAdvicePatientFrom({
        'id': 410,
        'patient_id': 22,
        'patient_uid': '8d4605e0-4bdb-4df5-9ac8-9a2c2db6065c',
        'patient_name': 'Asha Menon',
        'patient_phone': '9876543210',
      });

      expect(patient, isNotNull);
      expect(patient!['id'], 22);
      expect(patient['uid'], '8d4605e0-4bdb-4df5-9ac8-9a2c2db6065c');
      expect(patient['name'], 'Asha Menon');
      expect(patient['phone'], '9876543210');
    });

    test('maps nested patient details from advice rows', () {
      final patient = frontOfficeAdmissionAdvicePatientFrom({
        'appointment_id': 411,
        'patient': {
          'id': 25,
          'uid': 'd0ad03ab-30eb-4423-a3f4-25895bf1f0a1',
          'name': 'Ravi Kumar',
          'phone': '9123456780',
          'hospital_number': 'VH-25',
        },
      });

      expect(patient, isNotNull);
      expect(patient!['id'], 25);
      expect(patient['hospital_number'], 'VH-25');
      expect(patient['name'], 'Ravi Kumar');
    });
  });

  group('front-office OP queue gates', () {
    test('doctors use their assigned OP queue instead of the broad queue', () {
      expect(
        frontOfficeQueueScopeForRole(StaffRole.doctor),
        FrontOfficeQueueScope.mine,
      );
      expect(
        frontOfficeQueueScopeForRole(StaffRole.dutyDoctor),
        FrontOfficeQueueScope.mine,
      );
    });

    test('front-office counter roles can view and manage the broad queue', () {
      expect(
        frontOfficeQueueScopeForRole(StaffRole.receptionist),
        FrontOfficeQueueScope.full,
      );
      expect(frontOfficeCanBookOp(StaffRole.receptionist), isTrue);
      expect(
        frontOfficeCanManageAppointmentQueue(StaffRole.receptionist),
        isTrue,
      );
    });

    test('billing can see queue context but cannot manage OP status', () {
      expect(
        frontOfficeQueueScopeForRole(StaffRole.billingStaff),
        FrontOfficeQueueScope.full,
      );
      expect(frontOfficeCanBookOp(StaffRole.billingStaff), isFalse);
      expect(
        frontOfficeCanManageAppointmentQueue(StaffRole.billingStaff),
        isFalse,
      );
    });

    test(
      'ward nurses do not receive the broad OP queue from the workbench',
      () {
        expect(
          frontOfficeQueueScopeForRole(StaffRole.nurse),
          FrontOfficeQueueScope.none,
        );
        expect(frontOfficeCanCompleteAppointment(StaffRole.nurse), isTrue);
        expect(frontOfficeCanBookOp(StaffRole.nurse), isFalse);
      },
    );
  });
}
