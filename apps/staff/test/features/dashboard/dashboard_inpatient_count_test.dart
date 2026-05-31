import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/features/dashboard/dashboard_inpatient_count.dart';

void main() {
  group('dashboard inpatient count source', () {
    test('uses command board for clinical and governance inpatient roles', () {
      for (final role in [
        StaffRole.doctor,
        StaffRole.dutyDoctor,
        StaffRole.medicalSuperintendent,
        StaffRole.nurse,
        StaffRole.nursingIncharge,
        StaffRole.nursingSuperintendent,
        StaffRole.admin,
        StaffRole.superAdmin,
      ]) {
        expect(
          dashboardInpatientCountEndpointForRole(role),
          '/admissions/command-board',
        );
        expect(dashboardInpatientCountQueryForRole(role), {
          'status': 'active',
          'limit': '1',
        });
      }
    });

    test('keeps housekeeping on scoped occupancy and bed-board path', () {
      expect(
        dashboardInpatientCountEndpointForRole(StaffRole.housekeeping),
        '/admissions/occupancy',
      );
      expect(
        dashboardInpatientCountEndpointForRole(StaffRole.housekeepingIncharge),
        '/admissions/occupancy',
      );
      expect(
        dashboardInpatientCountQueryForRole(StaffRole.housekeeping),
        isNull,
      );
    });
  });

  group('dashboardInpatientCountFromRaw', () {
    test('reads command-board scoped total', () {
      expect(
        dashboardInpatientCountFromRaw({
          'data': {
            'board': {
              'counts': {'total': 8, 'returned': 1, 'loaded': 1},
            },
            'rows': [{}],
          },
        }),
        8,
      );
    });

    test('reads occupancy total', () {
      expect(
        dashboardInpatientCountFromRaw({
          'data': {
            'total': '6',
            'scope': {'type': 'ward_nursing'},
          },
        }),
        6,
      );
    });

    test('falls back to pagination and list-shaped payloads', () {
      expect(
        dashboardInpatientCountFromRaw({
          'data': [],
          'meta': {
            'pagination': {'totalItems': 46},
          },
        }),
        46,
      );
      expect(
        dashboardInpatientCountFromRaw({
          'data': {
            'admissions': [{}, {}, {}],
          },
        }),
        3,
      );
    });
  });
}
