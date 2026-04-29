// Unit tests for StaffRole enum + RoleFeatures dispatch.
// No Flutter runtime needed — StaffRole is pure Dart; RoleFeatures returns const lists.

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';

void main() {
  group('StaffRole.fromString', () {
    test('parses canonical uppercase backend values', () {
      expect(StaffRole.fromString('DOCTOR'), StaffRole.doctor);
      expect(StaffRole.fromString('NURSING_STAFF'), StaffRole.nurse);
      expect(StaffRole.fromString('HR_STAFF'), StaffRole.hr);
      expect(StaffRole.fromString('ADMIN'), StaffRole.admin);
      expect(StaffRole.fromString('SUPER_ADMIN'), StaffRole.superAdmin);
      expect(StaffRole.fromString('PHARMACY_STAFF'), StaffRole.pharmacy);
      expect(StaffRole.fromString('LAB_STAFF'), StaffRole.lab);
      expect(StaffRole.fromString('GENERAL_STAFF'), StaffRole.general);
    });

    test('trims and uppercases input', () {
      expect(StaffRole.fromString('  doctor  '), StaffRole.doctor);
      expect(StaffRole.fromString('Nursing_Staff'), StaffRole.nurse);
    });

    test('unknown role falls back to general (never null / throw)', () {
      expect(StaffRole.fromString('BOGUS_ROLE'), StaffRole.general);
      expect(StaffRole.fromString(''), StaffRole.general);
    });
  });

  group('StaffRole.isAdminTier', () {
    test('ADMIN + SUPER_ADMIN are admin tier', () {
      expect(StaffRole.admin.isAdminTier, isTrue);
      expect(StaffRole.superAdmin.isAdminTier, isTrue);
    });

    test('every other role is NOT admin tier', () {
      expect(StaffRole.doctor.isAdminTier, isFalse);
      expect(StaffRole.nurse.isAdminTier, isFalse);
      expect(StaffRole.hr.isAdminTier, isFalse);
      expect(StaffRole.pharmacy.isAdminTier, isFalse);
      expect(StaffRole.lab.isAdminTier, isFalse);
      expect(StaffRole.general.isAdminTier, isFalse);
    });
  });

  group('RoleFeatures.getFeaturesForRole', () {
    test('doctor gets clinical features but NOT HR dashboard', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.doctor);
      final ids = feats.map((f) => f.id).toSet();
      expect(ids, contains('appointments'));
      expect(ids, contains('prescriptions'));
      expect(ids, contains('patient_records'));
      expect(ids, contains('theatre'));
      expect(ids, contains('blood_bank'));
      expect(ids, isNot(contains('hr_dashboard')));
      expect(ids, isNot(contains('staff_management')));
    });

    test('nurse gets vitals + nursing notes + handover, NOT prescriptions', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.nurse);
      final ids = feats.map((f) => f.id).toSet();
      expect(ids, contains('vitals'));
      expect(ids, contains('nursing_notes'));
      expect(ids, contains('handover'));
      expect(ids, isNot(contains('prescriptions'))); // Rx is doctor-only
    });

    test('HR gets HR-specific features only, no clinical', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.hr);
      final ids = feats.map((f) => f.id).toSet();
      expect(ids, contains('hr_dashboard'));
      expect(ids, contains('staff_management'));
      expect(ids, isNot(contains('patient_records')));
      expect(ids, isNot(contains('prescriptions')));
      expect(ids, isNot(contains('vitals')));
    });

    test('pharmacy role sees only pharmacy + admin/profile/settings', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.pharmacy);
      final ids = feats.map((f) => f.id).toSet();
      expect(ids, contains('pharmacy_orders'));
      expect(ids, isNot(contains('patient_records')));
      expect(ids, isNot(contains('vitals')));
      expect(ids, isNot(contains('hr_dashboard')));
    });

    test(
      'lab role sees investigations upload + lab bookings, nothing clinical',
      () {
        final feats = RoleFeatures.getFeaturesForRole(StaffRole.lab);
        final ids = feats.map((f) => f.id).toSet();
        expect(ids, contains('investigations_upload'));
        expect(ids, contains('investigation_results'));
        expect(ids, contains('lab_bookings'));
        expect(ids, isNot(contains('patient_records')));
      },
    );

    test('admin + superAdmin get the superset (access to everything)', () {
      final adminFeats = RoleFeatures.getFeaturesForRole(StaffRole.admin);
      final superFeats = RoleFeatures.getFeaturesForRole(StaffRole.superAdmin);
      expect(
        adminFeats.map((f) => f.id).toSet(),
        equals(superFeats.map((f) => f.id).toSet()),
      );
      final ids = adminFeats.map((f) => f.id).toSet();
      expect(ids, contains('hr_dashboard'));
      expect(ids, contains('pharmacy_orders'));
      expect(ids, contains('theatre'));
      expect(ids, contains('blood_bank'));
    });

    test('general staff sees housekeeping hub + tasks, no clinical/HR', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.general);
      final ids = feats.map((f) => f.id).toSet();
      expect(ids, contains('housekeeping_hub'));
      expect(ids, contains('housekeeping_tasks'));
      expect(ids, isNot(contains('patient_records')));
      expect(ids, isNot(contains('hr_dashboard')));
    });
  });

  group('RoleFeatures.getBottomNavForRole', () {
    test('every role gets between 4 and 5 bottom-nav items', () {
      for (final role in StaffRole.values) {
        final items = RoleFeatures.getBottomNavForRole(role);
        expect(
          items.length,
          inInclusiveRange(4, 5),
          reason: 'Role $role had ${items.length} bottom-nav items',
        );
      }
    });

    test('every role\'s first bottom-nav item routes to /dashboard', () {
      for (final role in StaffRole.values) {
        final items = RoleFeatures.getBottomNavForRole(role);
        expect(
          items.first.route,
          '/dashboard',
          reason: 'Role $role did not start with /dashboard',
        );
      }
    });
  });
}
