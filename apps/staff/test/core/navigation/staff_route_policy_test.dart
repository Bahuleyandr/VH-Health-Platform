import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/core/config/staff_role_contract.g.dart';
import 'package:vhhealth_staff/core/navigation/staff_route_policy.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';

void main() {
  group('StaffRoutePolicy authorization', () {
    test('all canonical staff roles can enter the signed-in shell', () {
      for (final rawRole in canonicalStaffRoleCodes) {
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/dashboard'),
            rawRole: rawRole,
          ).allowed,
          isTrue,
          reason: rawRole,
        );
      }
    });

    test('backend-derived route gates preserve exact raw-role policy', () {
      for (final rawRole in canonicalStaffRoleCodes) {
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/vitals'),
            rawRole: rawRole,
          ).allowed,
          canonicalClinicalStaffRouteRoleCodes.contains(rawRole),
          reason: '$rawRole clinical route parity',
        );
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/phone/patient-lookup'),
            rawRole: rawRole,
          ).allowed,
          canonicalPatientLookupRouteRoleCodes.contains(rawRole),
          reason: '$rawRole patient lookup parity',
        );
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/maternity'),
            rawRole: rawRole,
          ).allowed,
          canonicalMaternityRouteRoleCodes.contains(rawRole),
          reason: '$rawRole maternity parity',
        );
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/calculators'),
            rawRole: rawRole,
          ).allowed,
          canonicalClinicalDocumentRouteRoleCodes.contains(rawRole),
          reason: '$rawRole clinical document parity',
        );
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/reports-grievances/admin'),
            rawRole: rawRole,
          ).allowed,
          canonicalPeopleOperationsRouteRoleCodes.contains(rawRole),
          reason: '$rawRole people operations parity',
        );
      }
    });

    test('every protected route preserves generated backend role parity', () {
      bool allowsGate(StaffRouteGate gate, String rawRole) => switch (gate) {
        StaffRouteGate.signedIn => true,
        StaffRouteGate.clinicalEntry =>
          canonicalClinicalStaffRouteRoleCodes.contains(rawRole),
        StaffRouteGate.patientLookup =>
          canonicalPatientLookupRouteRoleCodes.contains(rawRole),
        StaffRouteGate.maternity => canonicalMaternityRouteRoleCodes.contains(
          rawRole,
        ),
        StaffRouteGate.clinicalCalculators =>
          canonicalClinicalDocumentRouteRoleCodes.contains(rawRole),
        StaffRouteGate.reportAdministration =>
          canonicalPeopleOperationsRouteRoleCodes.contains(rawRole),
      };

      for (final metadata in StaffRoutePolicy.routes) {
        final path = metadata.template.replaceAll(
          RegExp(r':[A-Za-z][A-Za-z0-9_]*'),
          'test-id',
        );
        for (final rawRole in canonicalStaffRoleCodes) {
          final featureAllowed = metadata.anyFeatureIds.any(
            (featureId) =>
                canonicalStaffFeatureRouteRoleCodes[featureId]?.contains(
                  rawRole,
                ) ??
                false,
          );
          final gateAllowed = metadata.anyGates.any(
            (gate) => allowsGate(gate, rawRole),
          );
          expect(
            StaffRoutePolicy.authorize(
              Uri.parse(path),
              rawRole: rawRole,
            ).allowed,
            featureAllowed || gateAllowed,
            reason: '$rawRole ${metadata.template}',
          );
        }
      }
    });

    test('safety center and resus record admit every staff role', () {
      // Backend truth: /resuscitation/* is requireStaffOrAdmin (any staff),
      // so the Safety Center and the resus documentation record must not be
      // hidden behind the narrower phone_self_service capability group.
      expect(
        canonicalStaffFeatureRouteRoleCodes['safety_center'],
        containsAll(canonicalStaffRoleCodes),
      );
      for (final rawRole in canonicalStaffRoleCodes) {
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/safety-center'),
            rawRole: rawRole,
          ).allowed,
          isTrue,
          reason: '$rawRole safety center',
        );
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/safety/resus/42'),
            rawRole: rawRole,
          ).allowed,
          isTrue,
          reason: '$rawRole resus documentation',
        );
      }
      // Regression pins for the emergency/critical-care roles the old
      // phone_self_service gate excluded.
      for (final rawRole in const [
        'ER_STAFF',
        'EMERGENCY_RESPONDER',
        'ICU_NURSE',
      ]) {
        expect(
          canonicalStaffFeatureRouteRoleCodes['safety_center'],
          contains(rawRole),
        );
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/safety/resus/7'),
            rawRole: rawRole,
          ).allowed,
          isTrue,
          reason: rawRole,
        );
      }
    });

    test('HR self-service stays reachable for every staff role', () {
      // Backend truth: staff profile/attendance/leave/payroll/directory/
      // reports policies are allowSelf for every staff role
      // (staffAccessPolicyRegistry.js), so no staff role may lose these.
      const selfServiceFeatures = {
        'profile': '/profile',
        'leave': '/leave',
        'payroll': '/payroll',
        'attendance': '/attendance',
        'staff_directory': '/staff-directory',
        'reports_grievances': '/reports-grievances',
      };
      for (final entry in selfServiceFeatures.entries) {
        expect(
          canonicalStaffFeatureRouteRoleCodes[entry.key],
          containsAll(canonicalStaffRoleCodes),
          reason: entry.key,
        );
        for (final rawRole in canonicalStaffRoleCodes) {
          expect(
            StaffRoutePolicy.authorize(
              Uri.parse(entry.value),
              rawRole: rawRole,
            ).allowed,
            isTrue,
            reason: '$rawRole ${entry.value}',
          );
        }
      }
    });

    test(
      'lossy presentation aliases cannot change backend route authority',
      () {
        expect(
          StaffRole.tryFromString('PHYSIOTHERAPIST'),
          StaffRole.physiotherapist,
        );
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/vitals'),
            rawRole: 'PHYSIOTHERAPIST',
          ).allowed,
          isFalse,
        );
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/vitals'),
            rawRole: 'NURSING_SUPERINTENDENT',
          ).allowed,
          isTrue,
        );
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/phone/patient-lookup'),
            rawRole: 'NURSING_SUPERINTENDENT',
          ).allowed,
          isTrue,
        );
        for (final rawRole in [
          'MEDICAL_RECORDS',
          'DIETITIAN',
          'DIETARY_STAFF',
        ]) {
          final route = rawRole == 'MEDICAL_RECORDS'
              ? '/investigations'
              : '/dietary';
          expect(
            StaffRoutePolicy.authorize(
              Uri.parse(route),
              rawRole: rawRole,
            ).allowed,
            isTrue,
            reason: rawRole,
          );
        }
        for (final route in [
          '/patient-records',
          '/investigations',
          '/lab-bookings',
          '/blood-bank',
        ]) {
          expect(
            StaffRoutePolicy.authorize(
              Uri.parse(route),
              rawRole: 'TECHNICIAN',
            ).allowed,
            isFalse,
            reason: 'TECHNICIAN $route',
          );
        }
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/cath-lab'),
            rawRole: 'TECHNICIAN',
          ).allowed,
          isTrue,
        );
        for (final rawRole in [
          'ANAESTHETIST',
          'PHARMACY_STAFF',
          'ADMISSION_OFFICER',
          'IPD_COUNSELLOR',
        ]) {
          expect(
            StaffRoutePolicy.authorize(
              Uri.parse('/vitals'),
              rawRole: rawRole,
            ).allowed,
            isTrue,
            reason: rawRole,
          );
        }
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/reports-grievances/admin'),
            rawRole: 'MEDICAL_SUPERINTENDENT',
          ).allowed,
          isFalse,
        );
      },
    );

    test('allows a role only when its centralized capability matches', () {
      expect(
        StaffRoutePolicy.authorize(
          Uri.parse('/oncology'),
          rawRole: 'DOCTOR',
        ).allowed,
        isTrue,
      );
      expect(
        StaffRoutePolicy.authorize(
          Uri.parse('/oncology'),
          rawRole: 'HOUSEKEEPING_STAFF',
        ).allowed,
        isFalse,
      );
      expect(
        StaffRoutePolicy.authorize(
          Uri.parse('/audit-logs'),
          rawRole: 'SUPER_ADMIN',
        ).allowed,
        isTrue,
      );
      expect(
        StaffRoutePolicy.authorize(
          Uri.parse('/audit-logs'),
          rawRole: 'DOCTOR',
        ).allowed,
        isFalse,
      );
    });

    test('matches contextual routes before their screen can be built', () {
      expect(
        StaffRoutePolicy.authorize(
          Uri.parse('/emr/orders/patient-1/compose'),
          rawRole: 'DOCTOR',
        ).allowed,
        isTrue,
      );
      expect(
        StaffRoutePolicy.authorize(
          Uri.parse('/emr/orders/patient-1/compose'),
          rawRole: 'GENERAL_STAFF',
        ).allowed,
        isFalse,
      );
    });

    test('unknown role and unknown route fail closed', () {
      expect(
        StaffRoutePolicy.authorize(
          Uri.parse('/patient-records'),
          rawRole: 'NEW_UNMAPPED_ROLE',
        ).reason,
        'unknown_role',
      );
      expect(
        StaffRoutePolicy.authorize(
          Uri.parse('/future-clinical-screen'),
          rawRole: 'SUPER_ADMIN',
        ).reason,
        'unknown_route',
      );
      expect(
        StaffRoutePolicy.authorize(
          Uri.parse('/dashboard'),
          rawRole: 'NEW_UNMAPPED_ROLE',
        ).allowed,
        isFalse,
      );
    });

    test('every declared protected route has policy metadata', () {
      final source = File(
        'lib/core/navigation/app_router.dart',
      ).readAsStringSync();
      final declared = RegExp(r"path:\s*'([^']+)'")
          .allMatches(source)
          .map((match) => match.group(1)!)
          .where(
            (route) =>
                route.startsWith('/') && route != '/' && route != '/login',
          );

      expect(
        declared.where(
          (template) => !StaffRoutePolicy.hasMetadataForTemplate(template),
        ),
        isEmpty,
      );
    });

    test('every route feature id is backed by the generated role contract', () {
      final knownFeatureIds = StaffRole.values
          .expand(RoleFeatures.getFeaturesForRole)
          .map((feature) => feature.id)
          .toSet();
      final policyFeatureIds = StaffRoutePolicy.routes
          .expand((route) => route.anyFeatureIds)
          .toSet();

      expect(policyFeatureIds.difference(knownFeatureIds), isEmpty);
      expect(
        policyFeatureIds.difference(
          canonicalStaffFeatureRouteRoleCodes.keys.toSet(),
        ),
        isEmpty,
      );
    });
  });

  group('notification route allowlist', () {
    NotificationItem item(String route) => NotificationItem(
      title: 'Alert',
      body: 'Body',
      timestamp: DateTime.utc(2026, 8, 13),
      data: {'route': route},
    );

    test('accepts only allowlisted local routes and legacy aliases', () {
      expect(item('/appointments?date=2026-08-13').actionRoute, isNotNull);
      expect(item('/admissions').actionRoute, '/emr/admissions');
      expect(item('/housekeeping').actionRoute, '/housekeeping-tasks');
      expect(item('/audit-logs').actionRoute, isNull);
      expect(item('/oncology').actionRoute, isNull);
    });

    test(
      'rejects external, unknown, traversal, and query-injection routes',
      () {
        expect(item('https://evil.example/appointments').actionRoute, isNull);
        expect(item('//evil.example/appointments').actionRoute, isNull);
        expect(item('/appointments/../audit-logs').actionRoute, isNull);
        expect(item('/appointments?next=/audit-logs').actionRoute, isNull);
        expect(item('/appointments?date=%00').actionRoute, isNull);
        expect(
          item('/appointments?date=2026-08-13&date=2026-08-14').actionRoute,
          isNull,
        );
        expect(item('/not-a-staff-route').actionRoute, isNull);
      },
    );

    test('default notification routes also pass through the allowlist', () {
      final appointment = NotificationItem(
        title: 'Appointment',
        body: 'Changed',
        timestamp: DateTime.utc(2026, 8, 13),
        type: 'APPOINTMENT_UPDATED',
      );
      expect(appointment.actionRoute, '/appointments');
    });
  });
}
