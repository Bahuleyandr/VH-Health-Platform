// Unit tests for StaffRole enum + RoleFeatures dispatch.
// No Flutter runtime needed — StaffRole is pure Dart; RoleFeatures returns const lists.

import 'package:flutter/widgets.dart' show Locale;
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  final strings = AppStrings.forLocale(const Locale('en'));

  group('StaffRole.fromString', () {
    test('parses canonical uppercase backend values', () {
      expect(StaffRole.fromString('DOCTOR'), StaffRole.doctor);
      expect(StaffRole.fromString('ANESTHETIST'), StaffRole.anaesthetist);
      expect(StaffRole.fromString('RADIOLOGY_STAFF'), StaffRole.radiologyStaff);
      expect(StaffRole.fromString('NURSING_STAFF'), StaffRole.nurse);
      expect(StaffRole.fromString('HR_STAFF'), StaffRole.hr);
      expect(StaffRole.fromString('ADMIN'), StaffRole.admin);
      expect(StaffRole.fromString('SUPER_ADMIN'), StaffRole.superAdmin);
      expect(StaffRole.fromString('PHARMACY_STAFF'), StaffRole.pharmacy);
      expect(
        StaffRole.fromString('PHARMACY_INCHARGE'),
        StaffRole.pharmacyIncharge,
      );
      expect(
        StaffRole.fromString('STORES_PURCHASE_INCHARGE'),
        StaffRole.storesPurchaseIncharge,
      );
      expect(StaffRole.fromString('LAB_STAFF'), StaffRole.lab);
      expect(StaffRole.fromString('BILLING_STAFF'), StaffRole.billingStaff);
      expect(
        StaffRole.fromString('ADMISSION_OFFICER'),
        StaffRole.admissionOfficer,
      );
      expect(StaffRole.fromString('SECURITY'), StaffRole.security);
      expect(
        StaffRole.fromString('EMERGENCY_RESPONDER'),
        StaffRole.emergencyResponder,
      );
      expect(StaffRole.fromString('GENERAL_STAFF'), StaffRole.general);
    });

    test('trims and uppercases input', () {
      expect(StaffRole.fromString('  doctor  '), StaffRole.doctor);
      expect(StaffRole.fromString('Nursing_Staff'), StaffRole.nurse);
    });

    test('normalizes hospital role aliases used by inpatient scoping', () {
      expect(StaffRole.fromString('CONSULTANT_PHYSICIAN'), StaffRole.doctor);
      expect(StaffRole.fromString('ANAESTHETIST'), StaffRole.anaesthetist);
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
      expect(
        StaffRole.fromString('PURCHASE_INCHARGE'),
        StaffRole.storesPurchaseIncharge,
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
    test('display and roster label keys resolve through AppStrings', () {
      for (final role in StaffRole.values) {
        expect(strings.lookup(role.displayNameKey), isNot(role.displayNameKey));
        expect(role.displayNameKey, startsWith('role.display.'));
      }

      expect(
        strings.lookup(StaffRole.nurse.rosterDepartmentLabelKey),
        'Nursing',
      );
      expect(
        strings.lookup(
          StaffRole.rosterDepartmentLabelKeyFor('stores_purchase'),
        ),
        'Stores / Purchase',
      );
      expect(
        strings.lookup(StaffRole.rosterDepartmentLabelKeyFor(null)),
        'Not configured',
      );
    });

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
      expect(
        StaffRole.storesPurchaseIncharge.rosterDepartment,
        'stores_purchase',
      );
      expect(StaffRole.doctor.rosterDepartment, 'medical');
      expect(StaffRole.anaesthetist.rosterDepartment, 'medical');
      expect(StaffRole.emergencyResponder.rosterDepartment, 'ambulance');
    });

    test('does not invent a roster department for roles without one', () {
      expect(StaffRole.hr.rosterDepartment, isNull);
      expect(StaffRole.admin.rosterDepartment, isNull);
      expect(StaffRole.lab.rosterDepartment, isNull);
      expect(StaffRole.radiologyStaff.rosterDepartment, isNull);
      expect(StaffRole.security.rosterDepartment, isNull);
      expect(StaffRole.general.rosterDepartment, isNull);
    });
  });

  group('RoleFeatures.getFeaturesForRole', () {
    test('doctor gets clinical features but NOT HR dashboard', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.doctor);
      final ids = feats.map((f) => f.id).toSet();
      final opWorkspace = feats.singleWhere(
        (feature) => feature.id == 'op_doctor_workspace',
      );
      expect(ids, contains('op_doctor_workspace'));
      expect(
        opWorkspace.route,
        '/appointments?context=op&scope=my&workspace=doctor',
      );
      expect(ids, contains('patient_records'));
      expect(ids, contains('clinical_inbox'));
      expect(ids, contains('clinical_ai_review_queue'));
      expect(ids, contains('op_ai_assist'));
      expect(ids, contains('dental_charting'));
      expect(ids, contains('ward_mode'));
      expect(ids, isNot(contains('appointments')));
      expect(ids, isNot(contains('prescriptions')));
      expect(ids, isNot(contains('investigation_results')));
      expect(ids, isNot(contains('front_office_workbench')));
      expect(ids, isNot(contains('queue')));
      expect(ids, isNot(contains('cath_lab')));
      expect(ids, isNot(contains('theatre')));
      expect(ids, isNot(contains('radiology')));
      expect(ids, isNot(contains('blood_bank')));
      expect(ids, isNot(contains('hr_dashboard')));
      expect(ids, isNot(contains('staff_management')));
    });

    test(
      'generic/IP nurses get ward tools, not OP appointment or front-office access',
      () {
        final feats = RoleFeatures.getFeaturesForRole(StaffRole.nurse);
        final ids = feats.map((f) => f.id).toSet();
        final handover = feats.singleWhere((f) => f.id == 'handover');
        expect(ids, isNot(contains('front_office_workbench')));
        expect(ids, isNot(contains('appointments')));
        expect(ids, isNot(contains('admissions')));
        expect(ids, contains('patient_command_board'));
        expect(ids, contains('clinical_inbox'));
        expect(ids, contains('ward_mode'));
        expect(ids, isNot(contains('vitals')));
        expect(ids, contains('nursing_notes'));
        expect(handover.titleKey, 'role.feature.handover');
        expect(strings.lookup(handover.titleKey), 'Shift Handover');
        expect(ids, contains('clinical_ai_review_queue'));
        expect(ids, isNot(contains('prescriptions'))); // Rx is doctor-only
      },
    );

    test('OP nursing roles get OP appointment workflow access', () {
      final opStaffIds = RoleFeatures.getFeaturesForRole(
        StaffRole.opStaffNurse,
      ).map((f) => f.id).toSet();
      final opInchargeIds = RoleFeatures.getFeaturesForRole(
        StaffRole.opIncharge,
      ).map((f) => f.id).toSet();

      expect(
        opStaffIds,
        containsAll([
          'op_nursing_dashboard',
          'front_office_workbench',
          'appointments',
          'dental_charting',
        ]),
      );
      expect(
        opInchargeIds,
        containsAll([
          'op_nursing_dashboard',
          'front_office_workbench',
          'appointments',
          'dental_charting',
        ]),
      );
      expect(opStaffIds, isNot(contains('admissions')));
      expect(opInchargeIds, isNot(contains('admissions')));
    });

    test('HR gets HR-specific features only, no clinical', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.hr);
      final ids = feats.map((f) => f.id).toSet();
      expect(ids, contains('hr_dashboard'));
      expect(ids, contains('staff_roster'));
      expect(ids, contains('staff_management'));
      expect(ids, isNot(contains('staff_directory')));
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
      'stores/purchase role sees inventory workspace without clinical tools',
      () {
        final feats = RoleFeatures.getFeaturesForRole(
          StaffRole.storesPurchaseIncharge,
        );
        final ids = feats.map((f) => f.id).toSet();
        expect(ids, contains('pharmacy_orders'));
        expect(ids, contains('staff_directory'));
        expect(ids, isNot(contains('patient_command_board')));
        expect(ids, isNot(contains('clinical_ai_review_queue')));
        expect(ids, isNot(contains('patient_records')));
      },
    );

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

    test('radiology and anaesthetist roles get focused clinical tools', () {
      final radiologyIds = RoleFeatures.getFeaturesForRole(
        StaffRole.radiologyStaff,
      ).map((f) => f.id).toSet();
      final anaesthetistIds = RoleFeatures.getFeaturesForRole(
        StaffRole.anaesthetist,
      ).map((f) => f.id).toSet();

      expect(radiologyIds, containsAll(['radiology', 'investigations_upload']));
      expect(radiologyIds, isNot(contains('hr_dashboard')));
      expect(anaesthetistIds, containsAll(['theatre', 'patient_records']));
      expect(anaesthetistIds, isNot(contains('op_ai_assist')));
    });

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
        expect(ids, contains('staff_roster'));
        expect(ids, contains('staff_management'));
        expect(ids, contains('pharmacy_orders'));
        expect(ids, contains('clinical_ai_review_queue'));
        expect(ids, contains('dental_charting'));
        expect(ids, isNot(contains('op_ai_assist')));
        expect(ids, isNot(contains('staff_directory')));
        expect(ids, contains('staff_diagnostics'));
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
      expect(ids, contains('dental_charting'));
      expect(ids, contains('staff_roster'));
      expect(ids, isNot(contains('medical_roster')));
      expect(ids, isNot(contains('nursing_roster')));
      expect(ids, isNot(contains('op_nursing_roster')));
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
      expect(RoleFeatures.hasOpAiAssist(StaffRole.anaesthetist), isFalse);
      expect(RoleFeatures.hasOpAiAssist(StaffRole.receptionist), isFalse);
      expect(RoleFeatures.hasOpAiAssist(StaffRole.nurse), isFalse);
    });

    test('general staff sees housekeeping hub + tasks, no clinical/HR', () {
      final feats = RoleFeatures.getFeaturesForRole(StaffRole.general);
      final ids = feats.map((f) => f.id).toSet();
      expect(ids, contains('housekeeping_hub'));
      expect(ids, contains('housekeeping_tasks'));
      expect(ids, contains('payroll'));
      expect(ids, isNot(contains('patient_records')));
      expect(ids, isNot(contains('hr_dashboard')));
      expect(ids, isNot(contains('clinical_ai_review_queue')));
    });

    test('payroll self-service mirrors backend staff HR route allowlist', () {
      expect(RoleFeatures.hasPayrollSelfService(StaffRole.general), isTrue);
      expect(
        RoleFeatures.hasPayrollSelfService(StaffRole.billingStaff),
        isTrue,
      );
      expect(
        RoleFeatures.hasPayrollSelfService(StaffRole.billingIncharge),
        isFalse,
      );
      expect(
        RoleFeatures.hasPayrollSelfService(StaffRole.financeIncharge),
        isFalse,
      );

      for (final role in StaffRole.values) {
        final payrollFeatures = RoleFeatures.getFeaturesForRole(
          role,
        ).where((feature) => feature.id == 'payroll').toList();

        expect(
          payrollFeatures.isNotEmpty,
          RoleFeatures.hasPayrollSelfService(role),
          reason: '$role payroll self-service visibility drifted',
        );
        if (payrollFeatures.isNotEmpty) {
          expect(payrollFeatures, hasLength(1));
          expect(payrollFeatures.single.route, '/payroll');
        }
      }
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

    test('every staff role can open reports and grievances self-service', () {
      for (final role in StaffRole.values) {
        final features = RoleFeatures.getFeaturesForRole(role);
        final reports = features.where((f) => f.id == 'reports_grievances');
        expect(
          reports,
          hasLength(1),
          reason: 'Role $role should have exactly one reports entry',
        );
        expect(reports.single.route, '/reports-grievances');
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

    test('non-counter clinical roles do not get IP admission setup tools', () {
      for (final role in [
        StaffRole.doctor,
        StaffRole.dutyDoctor,
        StaffRole.anaesthetist,
        StaffRole.nurse,
        StaffRole.nursingIncharge,
        StaffRole.nursingSuperintendent,
        StaffRole.opStaffNurse,
      ]) {
        final ids = RoleFeatures.getFeaturesForRole(
          role,
        ).map((feature) => feature.id).toSet();
        expect(
          ids,
          isNot(contains('admissions')),
          reason: '$role should use Patient Command Board, not IP setup',
        );
      }
    });

    test('role-specific feature gates are enforced for every role', () {
      for (final role in StaffRole.values) {
        final ids = RoleFeatures.getFeaturesForRole(
          role,
        ).map((feature) => feature.id).toSet();

        expect(
          ids.contains('front_office_workbench'),
          RoleFeatures.hasFrontOfficeWorkbench(role),
          reason: '$role front-office visibility drifted',
        );
        expect(
          ids.contains('admissions'),
          RoleFeatures.hasIpAdmissionAccess(role),
          reason: '$role IP admission visibility drifted',
        );
        expect(
          ids.contains('billing_desk'),
          RoleFeatures.hasBillingDesk(role),
          reason: '$role billing visibility drifted',
        );
        expect(
          ids.contains('payroll'),
          RoleFeatures.hasPayrollSelfService(role),
          reason: '$role payroll visibility drifted',
        );
        expect(
          ids.contains('dental_charting'),
          RoleFeatures.hasDentalCharting(role),
          reason: '$role dental charting visibility drifted',
        );
        expect(
          ids.contains('audit_logs'),
          role == StaffRole.admin || role == StaffRole.superAdmin,
          reason: '$role audit log visibility drifted',
        );
        expect(
          ids.contains('staff_diagnostics'),
          role == StaffRole.admin || role == StaffRole.superAdmin,
          reason: '$role diagnostics visibility drifted',
        );
      }
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

    test('OP nursing roles open the OP nursing dashboard first', () {
      for (final role in [StaffRole.opStaffNurse, StaffRole.opIncharge]) {
        final items = RoleFeatures.getBottomNavForRole(role);
        expect(
          items.map((item) => item.route),
          contains('/op/nursing-dashboard'),
        );
        expect(
          items
              .firstWhere((item) => item.route == '/op/nursing-dashboard')
              .labelKey,
          'role.nav.op_nursing',
        );
        expect(
          strings.lookup(
            items
                .firstWhere((item) => item.route == '/op/nursing-dashboard')
                .labelKey,
          ),
          'OP Nursing',
        );
      }
    });

    test(
      'phone self-service navigation stays personal for operational roles',
      () {
        final routes = RoleFeatures.getPhoneSelfServiceNavForRole(
          StaffRole.receptionist,
        ).map((item) => item.route).toList();

        expect(routes, [
          '/dashboard',
          '/notifications',
          '/messaging',
          '/attendance',
          '/phone/more',
        ]);
        expect(routes, isNot(contains('/front-office')));
        expect(routes, isNot(contains('/reception-counter')));
        expect(routes, isNot(contains('/billing-desk')));
      },
    );

    test('new operational roles get focused bottom navigation', () {
      expect(
        RoleFeatures.getBottomNavForRole(
          StaffRole.nurse,
        ).map((item) => item.route),
        contains('/patient-command-board'),
      );
      expect(
        RoleFeatures.getBottomNavForRole(
          StaffRole.nurse,
        ).map((item) => item.route),
        isNot(contains('/appointments')),
      );
      expect(
        RoleFeatures.getBottomNavForRole(
          StaffRole.doctor,
        ).map((item) => item.route),
        contains('/appointments?context=op&scope=my&workspace=doctor'),
      );
      expect(
        RoleFeatures.getBottomNavForRole(
          StaffRole.doctor,
        ).map((item) => item.route),
        isNot(contains('/appointments')),
      );
      expect(
        RoleFeatures.getBottomNavForRole(
          StaffRole.anaesthetist,
        ).map((item) => item.route),
        contains('/theatre'),
      );
      expect(
        RoleFeatures.getBottomNavForRole(
          StaffRole.anaesthetist,
        ).map((item) => item.route),
        isNot(contains('/appointments')),
      );
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
      expect(RoleFeatures.hasFrontOfficeWorkbench(StaffRole.doctor), isFalse);
      expect(RoleFeatures.hasFrontOfficeWorkbench(StaffRole.nurse), isFalse);
      expect(RoleFeatures.hasBillingDesk(StaffRole.billingStaff), isTrue);
      expect(RoleFeatures.hasIpAdmissionAccess(StaffRole.receptionist), isTrue);
      expect(RoleFeatures.hasIpAdmissionAccess(StaffRole.nurse), isFalse);
      expect(RoleFeatures.hasIpAdmissionAccess(StaffRole.doctor), isFalse);
      expect(RoleFeatures.hasClinicalEntry(StaffRole.receptionist), isFalse);
      expect(RoleFeatures.hasClinicalEntry(StaffRole.doctor), isTrue);
      expect(RoleFeatures.hasClinicalInbox(StaffRole.doctor), isTrue);
      expect(RoleFeatures.hasClinicalInbox(StaffRole.nurse), isTrue);
      expect(RoleFeatures.hasClinicalInbox(StaffRole.pharmacy), isTrue);
      expect(RoleFeatures.hasClinicalInbox(StaffRole.admissionOfficer), isTrue);
      expect(RoleFeatures.hasClinicalInbox(StaffRole.ipdCounsellor), isTrue);
      expect(RoleFeatures.hasClinicalInbox(StaffRole.receptionist), isFalse);
      expect(RoleFeatures.hasClinicalInbox(StaffRole.billingStaff), isFalse);
      expect(RoleFeatures.hasClinicalInbox(StaffRole.lab), isFalse);
    });

    test('workbench navigation includes role-permitted destinations', () {
      final receptionistNav = RoleFeatures.getWorkbenchNavForRole(
        StaffRole.receptionist,
      );
      final doctorNav = RoleFeatures.getWorkbenchNavForRole(StaffRole.doctor);
      final receptionistRoutes = receptionistNav
          .map((item) => item.route)
          .toSet();
      final doctorRoutes = doctorNav.map((item) => item.route).toSet();
      final doctorLabelKeys = {
        for (final item in doctorNav) item.route: item.labelKey,
      };
      final admissionsLabelKey = receptionistNav
          .singleWhere((item) => item.route == '/emr/admissions')
          .labelKey;
      final patientRecordsLabelKey = doctorNav
          .singleWhere((item) => item.route == '/patient-records')
          .labelKey;

      expect(
        receptionistRoutes,
        containsAll(['/front-office', '/billing-desk']),
      );
      expect(strings.lookup(admissionsLabelKey), 'IP Admissions');
      expect(receptionistRoutes, isNot(contains('/appointment-queue')));
      expect(doctorRoutes, contains('/patient-records'));
      expect(doctorRoutes, contains('/clinical-inbox'));
      expect(doctorRoutes, contains('/dental'));
      expect(
        doctorRoutes,
        contains('/appointments?context=op&scope=my&workspace=doctor'),
      );
      expect(
        strings.lookup(
          doctorLabelKeys['/appointments?context=op&scope=my&workspace=doctor']!,
        ),
        'OP Workspace',
      );
      expect(doctorRoutes, isNot(contains('/appointments')));
      expect(doctorRoutes, isNot(contains('/front-office')));
      expect(strings.lookup(patientRecordsLabelKey), 'Patient Records');
      expect(doctorRoutes, isNot(contains('/appointment-queue')));
      expect(doctorRoutes, isNot(contains('/billing-desk')));
      expect(doctorRoutes, isNot(contains('/emr/admissions')));

      final nurseRoutes = RoleFeatures.getWorkbenchNavForRole(
        StaffRole.nurse,
      ).map((item) => item.route).toSet();
      expect(nurseRoutes, isNot(contains('/front-office')));
      expect(nurseRoutes, isNot(contains('/emr/admissions')));
      expect(nurseRoutes, contains('/patient-records'));
      expect(nurseRoutes, contains('/clinical-inbox'));

      final opNurseRoutes = RoleFeatures.getWorkbenchNavForRole(
        StaffRole.opStaffNurse,
      ).map((item) => item.route).toSet();
      expect(opNurseRoutes, contains('/clinical-inbox'));
      expect(opNurseRoutes, contains('/op/nursing-dashboard'));
      expect(opNurseRoutes, contains('/front-office'));
      expect(opNurseRoutes, contains('/dental'));
      expect(opNurseRoutes, isNot(contains('/emr/admissions')));
    });

    test('workbench side bar gates match role predicates for every role', () {
      for (final role in StaffRole.values) {
        final routes = RoleFeatures.getWorkbenchNavForRole(
          role,
        ).map((item) => item.route).toSet();

        expect(
          routes.contains('/front-office'),
          RoleFeatures.hasFrontOfficeWorkbench(role),
          reason: '$role front-office side bar visibility drifted',
        );
        expect(
          routes.contains('/emr/admissions'),
          RoleFeatures.hasIpAdmissionAccess(role),
          reason: '$role IP admissions side bar visibility drifted',
        );
        expect(
          routes.contains('/billing-desk'),
          RoleFeatures.hasBillingDesk(role),
          reason: '$role billing side bar visibility drifted',
        );
        expect(
          routes.contains('/clinical-inbox'),
          RoleFeatures.hasClinicalInbox(role),
          reason: '$role clinical inbox side bar visibility drifted',
        );
        expect(
          routes.contains('/payroll'),
          RoleFeatures.hasPayrollSelfService(role),
          reason: '$role payroll side bar visibility drifted',
        );
        expect(
          routes.contains('/dental'),
          RoleFeatures.hasDentalCharting(role),
          reason: '$role dental side bar visibility drifted',
        );
        expect(
          routes.contains('/audit-logs'),
          role == StaffRole.admin || role == StaffRole.superAdmin,
          reason: '$role audit side bar visibility drifted',
        );
        expect(
          routes.contains('/staff-diagnostics'),
          role == StaffRole.admin || role == StaffRole.superAdmin,
          reason: '$role diagnostics side bar visibility drifted',
        );
      }
    });

    test('staff governance navigation consolidates rosters into the hub', () {
      final hrRoutes = RoleFeatures.getWorkbenchNavForRole(
        StaffRole.hr,
      ).map((item) => item.route).toSet();
      final adminRoutes = RoleFeatures.getWorkbenchNavForRole(
        StaffRole.admin,
      ).map((item) => item.route).toSet();
      final medicalSuperRoutes = RoleFeatures.getWorkbenchNavForRole(
        StaffRole.medicalSuperintendent,
      ).map((item) => item.route).toSet();

      expect(hrRoutes, containsAll(['/staff-rosters', '/staff-management']));
      expect(adminRoutes, containsAll(['/staff-rosters', '/staff-management']));
      expect(medicalSuperRoutes, contains('/staff-rosters'));
      expect(medicalSuperRoutes, isNot(contains('/staff-management')));
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

    test('phone read-only patient lookup stays doctor-class only', () {
      expect(
        RoleFeatures.hasPhoneReadOnlyPatientLookup(StaffRole.doctor),
        isTrue,
      );
      expect(
        RoleFeatures.hasPhoneReadOnlyPatientLookup(StaffRole.dutyDoctor),
        isTrue,
      );
      expect(
        RoleFeatures.hasPhoneReadOnlyPatientLookup(StaffRole.anaesthetist),
        isTrue,
      );
      expect(
        RoleFeatures.hasPhoneReadOnlyPatientLookup(
          StaffRole.medicalSuperintendent,
        ),
        isTrue,
      );
      expect(
        RoleFeatures.hasPhoneReadOnlyPatientLookup(StaffRole.admin),
        isFalse,
      );
      expect(
        RoleFeatures.hasPhoneReadOnlyPatientLookup(StaffRole.superAdmin),
        isFalse,
      );
      expect(
        RoleFeatures.hasPhoneReadOnlyPatientLookup(StaffRole.nurse),
        isFalse,
      );
      expect(
        RoleFeatures.hasPhoneReadOnlyPatientLookup(StaffRole.receptionist),
        isFalse,
      );
      expect(
        RoleFeatures.hasPhoneReadOnlyPatientLookup(StaffRole.billingStaff),
        isFalse,
      );
      expect(
        RoleFeatures.hasPhoneReadOnlyPatientLookup(StaffRole.housekeeping),
        isFalse,
      );
      expect(
        RoleFeatures.hasPhoneReadOnlyPatientLookup(StaffRole.general),
        isFalse,
      );
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

  group('RoleFeatures.getPhoneSelfServiceNavForRole', () {
    test('phone mode exposes the non-clinical five-tab shell', () {
      final nav = RoleFeatures.getPhoneSelfServiceNavForRole(StaffRole.nurse);
      expect(nav.map((item) => strings.lookup(item.labelKey)).toList(), [
        'Home',
        'Alerts',
        'Messages',
        'Attendance',
        'More',
      ]);
      expect(nav.map((item) => item.route).toList(), [
        '/dashboard',
        '/notifications',
        '/messaging',
        '/attendance',
        '/phone/more',
      ]);
    });
  });
}
