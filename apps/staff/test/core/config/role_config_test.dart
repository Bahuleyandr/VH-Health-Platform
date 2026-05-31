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
      expect(StaffRole.fromString('BILLING_STAFF'), StaffRole.billingStaff);
      expect(
        StaffRole.fromString('ADMISSION_OFFICER'),
        StaffRole.admissionOfficer,
      );
      expect(StaffRole.fromString('GENERAL_STAFF'), StaffRole.general);
    });

    test('trims and uppercases input', () {
      expect(StaffRole.fromString('  doctor  '), StaffRole.doctor);
      expect(StaffRole.fromString('Nursing_Staff'), StaffRole.nurse);
    });

    test('normalizes hospital role aliases used by inpatient scoping', () {
      expect(StaffRole.fromString('CONSULTANT_PHYSICIAN'), StaffRole.doctor);
      expect(
        StaffRole.fromString('DUTY_MEDICAL_OFFICER'),
        StaffRole.dutyDoctor,
      );
      expect(
        StaffRole.fromString('MEDICAL_SUPERINTENDANT'),
        StaffRole.medicalSuperintendent,
      );
      expect(
        StaffRole.fromString('NURSING_SUPERVISOR'),
        StaffRole.nursingIncharge,
      );
      expect(
        StaffRole.fromString('HOUSEKEEPING_ATTENDANT'),
        StaffRole.housekeeping,
      );
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

  group('StaffRole.rosterDepartment', () {
    test('maps normal staff roles to their own roster department only', () {
      expect(StaffRole.nurse.rosterDepartment, 'nursing');
      expect(StaffRole.nursingIncharge.rosterDepartment, 'nursing');
      expect(StaffRole.opStaffNurse.rosterDepartment, 'op_nursing');
      expect(StaffRole.housekeeping.rosterDepartment, 'housekeeping');
      expect(StaffRole.receptionist.rosterDepartment, 'reception');
      expect(StaffRole.admissionOfficer.rosterDepartment, 'reception');
      expect(StaffRole.insuranceCoordinator.rosterDepartment, 'reception');
      expect(StaffRole.billingStaff.rosterDepartment, 'billing');
      expect(StaffRole.financeIncharge.rosterDepartment, 'billing');
      expect(StaffRole.driver.rosterDepartment, 'ambulance');
      expect(StaffRole.maintenance.rosterDepartment, 'maintenance');
      expect(StaffRole.pharmacy.rosterDepartment, 'pharmacy');
      expect(StaffRole.doctor.rosterDepartment, 'medical');
    });

    test('does not invent a roster department for roles without one', () {
      expect(StaffRole.hr.rosterDepartment, isNull);
      expect(StaffRole.admin.rosterDepartment, isNull);
      expect(StaffRole.lab.rosterDepartment, isNull);
      expect(StaffRole.general.rosterDepartment, isNull);
    });
  });

  group('RoleFeatures.getFeaturesForRole', () {
    test('doctor gets clinical features but NOT HR dashboard', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.doctor);
      final ids = feats.map((f) => f.id).toSet();
      expect(ids, contains('appointments'));
      expect(ids, contains('prescriptions'));
      expect(ids, contains('patient_records'));
      expect(ids, contains('clinical_ai_review_queue'));
      expect(ids, contains('op_ai_assist'));
      expect(ids, contains('theatre'));
      expect(ids, contains('blood_bank'));
      expect(ids, contains('ward_mode'));
      expect(ids, isNot(contains('hr_dashboard')));
      expect(ids, isNot(contains('staff_management')));
    });

    test(
      'nurse gets ward mode + vitals + nursing notes, NOT prescriptions',
      () {
        final feats = RoleFeatures.getFeaturesForRole(StaffRole.nurse);
        final ids = feats.map((f) => f.id).toSet();
        expect(ids, contains('ward_mode'));
        expect(ids, contains('vitals'));
        expect(ids, contains('nursing_notes'));
        expect(ids, contains('handover'));
        expect(ids, contains('clinical_ai_review_queue'));
        expect(ids, isNot(contains('prescriptions'))); // Rx is doctor-only
      },
    );

    test('HR gets HR-specific features only, no clinical', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.hr);
      final ids = feats.map((f) => f.id).toSet();
      expect(ids, contains('hr_dashboard'));
      expect(ids, contains('staff_management'));
      expect(ids, isNot(contains('patient_records')));
      expect(ids, isNot(contains('prescriptions')));
      expect(ids, isNot(contains('vitals')));
      expect(ids, isNot(contains('clinical_ai_review_queue')));
    });

    test('pharmacy role sees pharmacy + AI review, not broad clinical', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.pharmacy);
      final ids = feats.map((f) => f.id).toSet();
      expect(ids, contains('pharmacy_orders'));
      expect(ids, contains('clinical_ai_review_queue'));
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
        expect(ids, isNot(contains('clinical_ai_review_queue')));
      },
    );

    test(
      'admin + superAdmin get governance tools but not doctor-only OP AI Assist',
      () {
        final adminFeats = RoleFeatures.getFeaturesForRole(StaffRole.admin);
        final superFeats = RoleFeatures.getFeaturesForRole(
          StaffRole.superAdmin,
        );
        expect(
          adminFeats.map((f) => f.id).toSet(),
          equals(superFeats.map((f) => f.id).toSet()),
        );
        final ids = adminFeats.map((f) => f.id).toSet();
        expect(ids, contains('hr_dashboard'));
        expect(ids, contains('pharmacy_orders'));
        expect(ids, contains('clinical_ai_review_queue'));
        expect(ids, isNot(contains('op_ai_assist')));
        expect(ids, contains('theatre'));
        expect(ids, contains('blood_bank'));
        expect(ids, contains('front_office_workbench'));
        expect(ids, isNot(contains('reception_counter')));
        expect(ids, contains('ward_mode'));
      },
    );

    test('medical superintendent keeps doctor-facing OP AI Assist access', () {
      final ids = RoleFeatures.getFeaturesForRole(
        StaffRole.medicalSuperintendent,
      ).map((f) => f.id).toSet();

      expect(ids, contains('op_ai_assist'));
    });

    test('OP AI Assist role gate matches the doctor-only backend gate', () {
      expect(RoleFeatures.hasOpAiAssist(StaffRole.doctor), isTrue);
      expect(RoleFeatures.hasOpAiAssist(StaffRole.dutyDoctor), isTrue);
      expect(
        RoleFeatures.hasOpAiAssist(StaffRole.medicalSuperintendent),
        isTrue,
      );
      expect(RoleFeatures.hasOpAiAssist(StaffRole.admin), isFalse);
      expect(RoleFeatures.hasOpAiAssist(StaffRole.superAdmin), isFalse);
      expect(RoleFeatures.hasOpAiAssist(StaffRole.receptionist), isFalse);
      expect(RoleFeatures.hasOpAiAssist(StaffRole.nurse), isFalse);
    });

    test('general staff sees housekeeping hub + tasks, no clinical/HR', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.general);
      final ids = feats.map((f) => f.id).toSet();
      expect(ids, contains('housekeeping_hub'));
      expect(ids, contains('housekeeping_tasks'));
      expect(ids, isNot(contains('patient_records')));
      expect(ids, isNot(contains('hr_dashboard')));
      expect(ids, isNot(contains('clinical_ai_review_queue')));
    });

    test(
      'reception roles get the front office workbench, OPD appointments, and IP admissions',
      () {
        final receptionistIds = RoleFeatures.getFeaturesForRole(
          StaffRole.receptionist,
        ).map((f) => f.id).toSet();
        final inchargeIds = RoleFeatures.getFeaturesForRole(
          StaffRole.receptionIncharge,
        ).map((f) => f.id).toSet();

        expect(
          receptionistIds,
          containsAll([
            'front_office_workbench',
            'billing_desk',
            'appointments',
            'admissions',
          ]),
        );
        expect(
          inchargeIds,
          containsAll([
            'front_office_workbench',
            'billing_desk',
            'appointments',
            'admissions',
          ]),
        );
      },
    );

    test('legacy appointment queue is consolidated into front office', () {
      for (final role in StaffRole.values) {
        final ids = RoleFeatures.getFeaturesForRole(
          role,
        ).map((feature) => feature.id).toSet();
        expect(
          ids,
          isNot(contains('appointment_queue')),
          reason: 'Role $role should use front_office_workbench instead',
        );
      }
    });

    test('front-office and billing roles get workbench features', () {
      final billingIds = RoleFeatures.getFeaturesForRole(
        StaffRole.billingStaff,
      ).map((f) => f.id).toSet();
      final admissionIds = RoleFeatures.getFeaturesForRole(
        StaffRole.admissionOfficer,
      ).map((f) => f.id).toSet();

      expect(
        billingIds,
        containsAll(['front_office_workbench', 'billing_desk']),
      );
      expect(
        admissionIds,
        containsAll(['front_office_workbench', 'billing_desk', 'admissions']),
      );
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

    test(
      'reception roles open the consolidated front office in bottom navigation',
      () {
        final receptionistItems = RoleFeatures.getBottomNavForRole(
          StaffRole.receptionist,
        );
        final inchargeItems = RoleFeatures.getBottomNavForRole(
          StaffRole.receptionIncharge,
        );

        expect(
          receptionistItems.map((item) => item.route),
          contains('/front-office'),
        );
        expect(
          inchargeItems.map((item) => item.route),
          contains('/front-office'),
        );
      },
    );

    test(
      'phone self-service navigation stays personal for operational roles',
      () {
        final routes = RoleFeatures.getPhoneSelfServiceNavForRole(
          StaffRole.receptionist,
        ).map((item) => item.route).toList();

        expect(routes, [
          '/dashboard',
          '/attendance',
          '/schedule',
          '/leave',
          '/profile',
        ]);
        expect(routes, isNot(contains('/front-office')));
        expect(routes, isNot(contains('/reception-counter')));
        expect(routes, isNot(contains('/billing-desk')));
      },
    );

    test('new operational roles get focused bottom navigation', () {
      expect(
        RoleFeatures.getBottomNavForRole(
          StaffRole.billingStaff,
        ).map((item) => item.route),
        containsAll(['/billing-desk', '/front-office']),
      );
      expect(
        RoleFeatures.getBottomNavForRole(
          StaffRole.admissionOfficer,
        ).map((item) => item.route),
        containsAll(['/front-office', '/emr/admissions']),
      );
    });
  });

  group('RoleFeatures workbench role gates', () {
    test('front office, billing, and clinical access are distinct', () {
      expect(
        RoleFeatures.hasFrontOfficeWorkbench(StaffRole.receptionist),
        isTrue,
      );
      expect(RoleFeatures.hasBillingDesk(StaffRole.billingStaff), isTrue);
      expect(RoleFeatures.hasClinicalEntry(StaffRole.receptionist), isFalse);
      expect(RoleFeatures.hasClinicalEntry(StaffRole.doctor), isTrue);
    });

    test('workbench navigation includes role-permitted destinations', () {
      final receptionistRoutes = RoleFeatures.getWorkbenchNavForRole(
        StaffRole.receptionist,
      ).map((item) => item.route).toSet();
      final doctorRoutes = RoleFeatures.getWorkbenchNavForRole(
        StaffRole.doctor,
      ).map((item) => item.route).toSet();

      expect(
        receptionistRoutes,
        containsAll(['/front-office', '/billing-desk']),
      );
      expect(receptionistRoutes, isNot(contains('/appointment-queue')));
      expect(doctorRoutes, containsAll(['/front-office', '/patient-records']));
      expect(doctorRoutes, isNot(contains('/appointment-queue')));
      expect(doctorRoutes, isNot(contains('/billing-desk')));
    });

    test('patient lookup follows backend demographic access gates', () {
      expect(RoleFeatures.hasPatientLookup(StaffRole.doctor), isTrue);
      expect(RoleFeatures.hasPatientLookup(StaffRole.nurse), isTrue);
      expect(RoleFeatures.hasPatientLookup(StaffRole.receptionist), isTrue);
      expect(RoleFeatures.hasPatientLookup(StaffRole.billingStaff), isTrue);
      expect(RoleFeatures.hasPatientLookup(StaffRole.general), isFalse);
      expect(RoleFeatures.hasPatientLookup(StaffRole.housekeeping), isFalse);
      expect(RoleFeatures.hasPatientLookup(StaffRole.maintenance), isFalse);
      expect(RoleFeatures.hasPatientLookup(StaffRole.hr), isFalse);
    });

    test(
      'patient registry writes stay limited to front-office governance roles',
      () {
        expect(
          RoleFeatures.hasPatientRegistryWrite(StaffRole.receptionist),
          isTrue,
        );
        expect(
          RoleFeatures.hasPatientRegistryWrite(StaffRole.admissionOfficer),
          isTrue,
        );
        expect(
          RoleFeatures.hasPatientRegistryWrite(StaffRole.billingStaff),
          isTrue,
        );
        expect(RoleFeatures.hasPatientRegistryWrite(StaffRole.doctor), isFalse);
        expect(RoleFeatures.hasPatientRegistryWrite(StaffRole.nurse), isFalse);
        expect(
          RoleFeatures.hasPatientRegistryWrite(StaffRole.general),
          isFalse,
        );
      },
    );
  });
}
