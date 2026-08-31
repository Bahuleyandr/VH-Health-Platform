import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/core/config/staff_role_contract.g.dart';
import 'package:vhhealth_staff/core/config/ward_indent_role_contract.dart';
import 'package:vhhealth_staff/core/navigation/staff_route_policy.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

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

    test(
      'ER and stores owners can enter the role-gated ward-indent workbench',
      () {
        for (final rawRole in const ['ER_STAFF', 'STORES_PURCHASE_INCHARGE']) {
          expect(
            StaffRoutePolicy.authorize(
              Uri.parse('/pharmacy?tab=ward-indents&indent_id=73'),
              rawRole: rawRole,
            ).allowed,
            isTrue,
            reason: rawRole,
          );
        }
      },
    );

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
        StaffRouteGate.wardIndent =>
          WardIndentRoleContract.readRoleCodes.contains(rawRole),
        StaffRouteGate.marSupplyReconciliation => const {
          'ADMIN',
          'SUPER_ADMIN',
          'PHARMACY_INCHARGE',
          'NURSING_INCHARGE',
          'IP_INCHARGE',
        }.contains(rawRole),
        StaffRouteGate.cathInventoryReconciliation => const {
          'PHARMACIST',
          'PHARMACY_STAFF',
          'PHARMACY_INCHARGE',
          'ADMIN',
          'SUPER_ADMIN',
        }.contains(rawRole),
        StaffRouteGate.platformAdmin => const {
          'ADMIN',
          'SUPER_ADMIN',
        }.contains(rawRole),
        StaffRouteGate.counterSaleRefundFinance => const {
          'ADMIN',
          'SUPER_ADMIN',
          'FINANCE_INCHARGE',
          'BILLING_INCHARGE',
          'BILLING_STAFF',
          'CASHIER',
        }.contains(rawRole),
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

    test('alert recovery workbench is exactly platform-admin scoped', () {
      for (final role in canonicalStaffRoleCodes) {
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/clinical-inbox/recovery?case_id=73'),
            rawRole: role,
          ).allowed,
          const {'ADMIN', 'SUPER_ADMIN'}.contains(role),
          reason: role,
        );
      }
      expect(
        StaffRoutePolicy.sanitizeExternalRoute(
          '/clinical-inbox/recovery?case_id=9223372036854775806',
        ),
        '/clinical-inbox/recovery?case_id=9223372036854775806',
      );
      for (final hostile in [
        '/clinical-inbox/recovery?case_id=0',
        '/clinical-inbox/recovery?case_id=-1',
        '/clinical-inbox/recovery?case_id=01',
        '/clinical-inbox/recovery?case_id=9223372036854775808',
        '/clinical-inbox/recovery?case_id=73&case_id=74',
        '/clinical-inbox/recovery?case_id=73&recipient_id=doctor-1',
        '/api/v1/admin/clinical-alert-delivery/recovery-cases/73',
      ]) {
        expect(
          StaffRoutePolicy.sanitizeExternalRoute(hostile),
          isNull,
          reason: hostile,
        );
      }
    });

    test('counter-sale refund workbench has exact finance role parity', () {
      const allowed = {
        'ADMIN',
        'SUPER_ADMIN',
        'FINANCE_INCHARGE',
        'BILLING_INCHARGE',
        'BILLING_STAFF',
        'CASHIER',
      };
      for (final role in canonicalStaffRoleCodes) {
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/billing/refunds?refund_id=7&void_request_id=73'),
            rawRole: role,
          ).allowed,
          allowed.contains(role),
          reason: role,
        );
      }
    });

    test('gateway refund reconciliation is exactly platform-admin scoped', () {
      for (final role in canonicalStaffRoleCodes) {
        expect(
          StaffRoutePolicy.authorize(
            Uri.parse('/billing/gateway-refund-reconciliation?refund_id=31'),
            rawRole: role,
          ).allowed,
          const {'ADMIN', 'SUPER_ADMIN'}.contains(role),
          reason: role,
        );
      }
    });

    test('gateway refund recovery deep links enforce the int4 boundary', () {
      const maximum =
          '/billing/gateway-refund-reconciliation?refund_id=2147483647';
      expect(StaffRoutePolicy.sanitizeExternalRoute(maximum), maximum);
      expect(
        StaffRoutePolicy.sanitizeExternalRoute(
          '/billing/gateway-refund-reconciliation',
        ),
        '/billing/gateway-refund-reconciliation',
      );
      for (final hostile in [
        '/billing/gateway-refund-reconciliation?refund_id=0',
        '/billing/gateway-refund-reconciliation?refund_id=01',
        '/billing/gateway-refund-reconciliation?refund_id=2147483648',
        '/billing/gateway-refund-reconciliation?refund_id=31&next=/audit-logs',
        '/billing/gateway-refund-reconciliation?refund_id=31&refund_id=32',
      ]) {
        expect(
          StaffRoutePolicy.sanitizeExternalRoute(hostile),
          isNull,
          reason: hostile,
        );
      }
    });

    test('Cath inventory recovery has exact pharmacy-family role parity', () {
      const allowed = {
        'PHARMACIST',
        'PHARMACY_STAFF',
        'PHARMACY_INCHARGE',
        'ADMIN',
        'SUPER_ADMIN',
      };
      final route = Uri.parse(
        '/pharmacy/cath-inventory-reconciliation?case_id=7'
        '&consumable_usage_id=73',
      );
      for (final role in canonicalStaffRoleCodes) {
        expect(
          StaffRoutePolicy.authorize(route, rawRole: role).allowed,
          allowed.contains(role),
          reason: role,
        );
      }
    });

    test('Cath inventory recovery requires two exact positive identifiers', () {
      const valid =
          '/pharmacy/cath-inventory-reconciliation?case_id=7'
          '&consumable_usage_id=9223372036854775806';
      expect(StaffRoutePolicy.sanitizeExternalRoute(valid), valid);

      for (final hostile in [
        '/pharmacy/cath-inventory-reconciliation',
        '/pharmacy/cath-inventory-reconciliation?case_id=7',
        '/pharmacy/cath-inventory-reconciliation?consumable_usage_id=73',
        '/pharmacy/cath-inventory-reconciliation?case_id=0&consumable_usage_id=73',
        '/pharmacy/cath-inventory-reconciliation?case_id=-1&consumable_usage_id=73',
        '/pharmacy/cath-inventory-reconciliation?case_id=07&consumable_usage_id=73',
        '/pharmacy/cath-inventory-reconciliation?case_id=9223372036854775808&consumable_usage_id=73',
        '/pharmacy/cath-inventory-reconciliation?case_id=7&consumable_usage_id=0',
        '/pharmacy/cath-inventory-reconciliation?case_id=7&consumable_usage_id=-1',
        '/pharmacy/cath-inventory-reconciliation?case_id=7&consumable_usage_id=073',
        '/pharmacy/cath-inventory-reconciliation?case_id=7&consumable_usage_id=9223372036854775808',
        '/pharmacy/cath-inventory-reconciliation?case_id=7&case_id=8&consumable_usage_id=73',
        '/pharmacy/cath-inventory-reconciliation?case_id=7&consumable_usage_id=73&next=/audit-logs',
        '/cath-lab?case_id=7&consumable_usage_id=73',
      ]) {
        expect(
          StaffRoutePolicy.sanitizeExternalRoute(hostile),
          isNull,
          reason: hostile,
        );
      }
    });

    test(
      'counter-sale workflow deep links require exact positive identifiers',
      () {
        expect(
          StaffRoutePolicy.sanitizeExternalRoute(
            '/billing/refunds?refund_id=7&void_request_id=9223372036854775806',
          ),
          '/billing/refunds?refund_id=7&void_request_id=9223372036854775806',
        );
        expect(
          StaffRoutePolicy.sanitizeExternalRoute(
            '/billing/refunds?refund_id=7',
          ),
          '/billing/refunds?refund_id=7',
        );
        expect(
          StaffRoutePolicy.sanitizeExternalRoute(
            '/pharmacy?tab=counter-sales&sale_id=9223372036854775806',
          ),
          '/pharmacy?tab=counter-sales&sale_id=9223372036854775806',
        );

        for (final hostile in [
          '/billing/refunds',
          '/billing/refunds?void_request_id=73',
          '/billing/refunds?refund_id=2147483648',
          '/billing/refunds?refund_id=9223372036854775808',
          '/billing/refunds?refund_id=0&void_request_id=73',
          '/billing/refunds?refund_id=-1&void_request_id=73',
          '/billing/refunds?refund_id=07&void_request_id=73',
          '/billing/refunds?refund_id=7&void_request_id=0',
          '/billing/refunds?refund_id=7&void_request_id=-1',
          '/billing/refunds?refund_id=7&void_request_id=073',
          '/billing/refunds?refund_id=7&refund_id=8&void_request_id=73',
          '/billing/refunds?refund_id=7&void_request_id=73&next=/audit-logs',
          '/pharmacy?tab=counter-sales',
          '/pharmacy?tab=counter-sales&sale_id=0',
          '/pharmacy?tab=counter-sales&sale_id=-1',
          '/pharmacy?tab=counter-sales&sale_id=073',
          '/pharmacy?tab=counter-sales&sale_id=73&sale_id=74',
          '/pharmacy?tab=counter-sales&sale_id=73&indent_id=91',
          '/pharmacy?tab=counter-sales&sale_id=73&next=/audit-logs',
        ]) {
          expect(
            StaffRoutePolicy.sanitizeExternalRoute(hostile),
            isNull,
            reason: hostile,
          );
        }
      },
    );

    test('credit-note deep links require a canonical signed-bigint id', () {
      expect(
        StaffRoutePolicy.sanitizeExternalRoute(
          '/billing/credit-notes/9223372036854775807',
        ),
        '/billing/credit-notes/9223372036854775807',
      );
      for (final hostile in [
        '/billing/credit-notes/0',
        '/billing/credit-notes/-1',
        '/billing/credit-notes/07',
        '/billing/credit-notes/not-an-id',
        '/billing/credit-notes/9223372036854775808',
        '/billing/credit-notes/7?next=/audit-logs',
      ]) {
        expect(
          StaffRoutePolicy.sanitizeExternalRoute(hostile),
          isNull,
          reason: hostile,
        );
      }
    });

    test('every declared protected route has policy metadata', () {
      final source = File('lib/core/navigation/app_router.dart')
          .readAsStringSync();
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
      expect(
        item('/pharmacy?tab=ward-indents&indent_id=73').actionRoute,
        '/pharmacy?tab=ward-indents&indent_id=73',
      );
      expect(
        item('/pharmacy?tab=counter-sales&sale_id=73').actionRoute,
        '/pharmacy?tab=counter-sales&sale_id=73',
      );
      expect(
        item('/billing/refunds?refund_id=7&void_request_id=73').actionRoute,
        '/billing/refunds?refund_id=7&void_request_id=73',
      );
      expect(
        item(
          '/pharmacy/cath-inventory-reconciliation?case_id=7'
          '&consumable_usage_id=73',
        ).actionRoute,
        '/pharmacy/cath-inventory-reconciliation?case_id=7'
        '&consumable_usage_id=73',
      );
      expect(item('/admissions').actionRoute, '/emr/admissions');
      expect(item('/housekeeping').actionRoute, '/housekeeping-tasks');
      expect(
        item('/clinical/mar/42?supply-reconciliation=1').actionRoute,
        '/mar/reconcile/42',
      );
      expect(item('/mar/reconcile/42').actionRoute, '/mar/reconcile/42');
      expect(
        item('/mar/reconcile/2147483647').actionRoute,
        '/mar/reconcile/2147483647',
      );
      for (final hostile in [
        '/mar/reconcile/0',
        '/mar/reconcile/01',
        '/mar/reconcile/2147483648',
        '/clinical/mar/2147483648?supply-reconciliation=1',
      ]) {
        expect(item(hostile).actionRoute, isNull, reason: hostile);
      }
      expect(item('/audit-logs').actionRoute, isNull);
      expect(item('/oncology').actionRoute, isNull);
    });

    test('uses data.deep_link when data.route is absent', () {
      final notification = NotificationItem(
        title: 'MAR supply evidence required',
        body: 'Reconcile exact allocation quantities',
        timestamp: DateTime.utc(2026, 8, 27),
        data: const {'deep_link': '/mar/reconcile/42'},
      );

      expect(notification.actionRoute, '/mar/reconcile/42');
    });

    test('gateway refund reconciliation notifications are localized and actionable', () {
      final notification = NotificationItem(
        title: 'raw gateway title',
        body: 'raw gateway body',
        type: 'GATEWAY_REFUND_RECONCILIATION',
        timestamp: DateTime.utc(2026, 8, 28),
        data: const {
          'route': '/billing/gateway-refund-reconciliation?refund_id=31',
          'action_label_key':
              'med03.notification.gateway_refund_reconciliation.action',
        },
      );
      final strings = AppStrings.forLocale(const Locale('en'));

      expect(
        notification.actionRoute,
        '/billing/gateway-refund-reconciliation?refund_id=31',
      );
      expect(
        notification.titleFor(strings),
        'Provider refund needs reconciliation',
      );
      expect(
        notification.bodyFor(strings),
        'A gateway refund is parked. Verify provider evidence and record the exact outcome.',
      );
      expect(
        notification.actionLabelFor(strings),
        'Open refund reconciliation',
      );
    });

    test('medication exception notification accepts only one positive local case id', () {
      expect(
        item('/mar/due?exception_id=73').actionRoute,
        '/mar/due?exception_id=73',
      );
      for (final hostile in [
        '/mar/due?exception_id=0',
        '/mar/due?exception_id=-1',
        '/mar/due?exception_id=01',
        '/mar/due?exception_id=not-an-id',
        '/mar/due?exception_id=73&exception_id=74',
        '/mar/due?exception_id=73&next=/audit-logs',
      ]) {
        expect(item(hostile).actionRoute, isNull, reason: hostile);
      }
    });

    test(
      'alert recovery notification resolves only its local workbench route',
      () {
        final notification = NotificationItem(
          title: 'Recovery overdue',
          body: 'Action required',
          timestamp: DateTime.utc(2026, 8, 27),
          data: const {
            'route': '/clinical-inbox/recovery?case_id=73',
            'action_path':
                '/api/v1/admin/clinical-alert-delivery/recovery-cases/73',
            'action_label_key': 'clinical_inbox.open_workflow',
          },
        );

        expect(notification.actionRoute, '/clinical-inbox/recovery?case_id=73');
        expect(notification.actionLabel, 'Open workflow');
        final rawApiOnly = NotificationItem(
          title: 'Recovery overdue',
          body: 'Action required',
          timestamp: DateTime.utc(2026, 8, 27),
          data: const {
            'action_path':
                '/api/v1/admin/clinical-alert-delivery/recovery-cases/73',
          },
        );
        expect(rawApiOnly.actionRoute, isNull);
      },
    );

    test('allows only exact governed medication recovery links', () {
      const uid = '11111111-1111-4111-8111-111111111111';
      expect(
        item('/emr/orders/$uid?mar_recovery_order=73').actionRoute,
        '/emr/orders/$uid?mar_recovery_order=73',
      );
      expect(item('/emr/orders/$uid').actionRoute, isNull);
      expect(
        item('/emr/orders/not-a-uid?mar_recovery_order=73').actionRoute,
        isNull,
      );
      expect(item('/emr/orders/$uid?mar_recovery_order=0').actionRoute, isNull);
      expect(
        item('/emr/orders/$uid?mar_recovery_order=73&next=/audit-logs')
            .actionRoute,
        isNull,
      );
      expect(
        item('/emr/orders/$uid?icu_mar_review=81').actionRoute,
        '/emr/orders/$uid?icu_mar_review=81',
      );
      for (final hostile in [
        '/emr/orders/$uid?icu_mar_review=0',
        '/emr/orders/$uid?icu_mar_review=-1',
        '/emr/orders/$uid?icu_mar_review=01',
        '/emr/orders/$uid?icu_mar_review=not-an-id',
        '/emr/orders/$uid?icu_mar_review=81&icu_mar_review=82',
        '/emr/orders/$uid?icu_mar_review=81&mar_recovery_order=73',
        '/emr/orders/$uid?icu_mar_review=81&encounter=enc-1',
      ]) {
        expect(item(hostile).actionRoute, isNull, reason: hostile);
      }
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
        expect(
          item('/pharmacy?tab=ward-indents&indent_id=73&indent_id=74')
              .actionRoute,
          isNull,
        );
        expect(item('/pharmacy?tab=orders&indent_id=73').actionRoute, isNull);
        expect(
          item('/pharmacy?tab=ward-indents&indent_id=0').actionRoute,
          isNull,
        );
        expect(
          item('/pharmacy?tab=ward-indents&indent_id=2147483648').actionRoute,
          isNull,
        );
        expect(item('/pharmacy?indent_id=73').actionRoute, isNull);
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

    test('ward indent alerts are actionable only after the dispatch gate', () {
      final held = NotificationItem(
        title: 'Ward drug indent recorded',
        body: 'Use the current manual process',
        timestamp: DateTime.utc(2026, 8, 27),
        type: 'WARD_PHARMACY_INDENT',
        data: const {'indent_id': 73, 'dispatch_surface_available': false},
      );
      final active = NotificationItem(
        title: 'Ward drug indent requested',
        body: 'Open the worklist',
        timestamp: DateTime.utc(2026, 8, 27),
        type: 'WARD_PHARMACY_INDENT',
        data: const {
          'indent_id': 73,
          'dispatch_surface_available': true,
          'route': '/pharmacy?tab=ward-indents&indent_id=73',
          'action_label': 'Open ward indent',
        },
      );

      expect(held.actionRoute, isNull);
      expect(active.actionRoute, '/pharmacy?tab=ward-indents&indent_id=73');
      expect(active.actionLabel, 'Open ward indent');
    });
  });
}
