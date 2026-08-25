// Pins for the 2026-08-22 audit's contract-gap findings.
//
// The dashboard renders RoleFeatures.getFeaturesForRawRole — the hand-written
// per-role list INTERSECTED with the generated canonical contract — while the
// long-standing suite asserts against getFeaturesForRole (the hand-written
// switch alone). That gap is how three whole modules (Maternity, Clinical
// Calculators, Nursing Notes) shipped with no contract entry and therefore
// never rendered for ANY canonical role, with every test green.
//
// These tests go through the same path the dashboard uses.

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/core/config/staff_role_contract.g.dart';
import 'package:vhhealth_staff/core/navigation/staff_route_policy.dart';

Set<String> renderedIds(String rawRole, {String? department}) =>
    RoleFeatures.getFeaturesForRawRole(
      rawRole,
      department: department,
    ).map((feature) => feature.id).toSet();

const specialtyIds = {
  'dental_charting',
  'oncology',
  'radiation_oncology',
  'ophthalmology',
  'transplant_program',
};

void main() {
  group('rendered (contract-intersected) features', () {
    test('a doctor renders maternity and calculators', () {
      final ids = renderedIds('DOCTOR');
      expect(ids, contains('maternity'));
      expect(ids, contains('calculators'));
    });

    test('a ward nurse renders nursing notes and maternity', () {
      final ids = renderedIds('NURSING_STAFF');
      expect(ids, contains('nursing_notes'));
      expect(ids, contains('maternity'));
    });

    test('an IP staff nurse renders nursing notes', () {
      final ids = renderedIds('IP_STAFF_NURSE');
      expect(ids, contains('nursing_notes'));
    });

    test('a General Medicine doctor renders NO specialty tiles', () {
      final ids = renderedIds('DOCTOR', department: 'General Medicine');
      expect(ids.intersection(specialtyIds), isEmpty);
    });

    test('a Dentistry doctor keeps dental charting and only dental charting '
        'of the specialty set', () {
      final ids = renderedIds('DOCTOR', department: 'Dentistry');
      expect(ids, contains('dental_charting'));
      expect(ids.intersection(specialtyIds), {'dental_charting'});
    });

    test('an Oncology doctor keeps oncology and radiation oncology', () {
      final ids = renderedIds('DOCTOR', department: 'Oncology');
      expect(ids, containsAll(['oncology', 'radiation_oncology']));
      expect(ids.contains('dental_charting'), isFalse);
    });

    test('a Nephrology doctor keeps the transplant programme', () {
      final ids = renderedIds('DOCTOR', department: 'Nephrology');
      expect(ids, contains('transplant_program'));
    });

    test('a doctor with NO stored department renders no specialty tiles '
        '(fail-closed, mirroring server enforce)', () {
      final ids = renderedIds('DOCTOR');
      expect(ids.intersection(specialtyIds), isEmpty);
    });

    test('the Medical Superintendent bypasses the department filter', () {
      final withDept = renderedIds(
        'MEDICAL_SUPERINTENDENT',
        department: 'Medical Administration',
      );
      final withoutDept = renderedIds('MEDICAL_SUPERINTENDENT');
      // Bypass means department never changes what the role itself grants.
      expect(withDept, withoutDept);
    });

    test('department normalization strips punctuation and parentheticals', () {
      expect(
        RoleFeatures.normalizeStaffDepartment('ENT (Otorhinolaryngology)'),
        'ent',
      );
      expect(
        RoleFeatures.normalizeStaffDepartment(' Radiation-Oncology '),
        'radiation oncology',
      );
    });

    test('the workbench SIDEBAR applies the same department filter as the '
        'grids (it was the one surface that missed it)', () {
      Set<String> navIds(StaffRole role, String rawRole, String? department) =>
          RoleFeatures.getWorkbenchNavForRole(
            role,
            rawRole: rawRole,
            department: department,
          ).map((item) => item.featureId).whereType<String>().toSet();

      final gmDoctor = navIds(StaffRole.doctor, 'DOCTOR', 'General Medicine');
      expect(gmDoctor.intersection(specialtyIds), isEmpty);

      final dentist = navIds(StaffRole.doctor, 'DOCTOR', 'Dentistry');
      expect(dentist, contains('dental_charting'));
      expect(dentist.intersection(specialtyIds), {'dental_charting'});

      // Missing department fails closed on the rail too.
      final noDept = navIds(StaffRole.doctor, 'DOCTOR', null);
      expect(noDept.intersection(specialtyIds), isEmpty);

      // Leadership bypass: department never changes what the role grants.
      expect(
        navIds(
          StaffRole.medicalSuperintendent,
          'MEDICAL_SUPERINTENDENT',
          'Medical Administration',
        ),
        navIds(StaffRole.medicalSuperintendent, 'MEDICAL_SUPERINTENDENT', null),
      );
    });

    test('every hand-granted feature id has a contract entry — a feature with '
        'none can never render for ANY canonical role', () {
      // Narrowing is legitimate (the contract may deny a feature to a role the
      // hand-written list grants — e.g. biomed_work_orders for nurses mirrors
      // the backend gate, and a hidden tile beats a tile that 403s). A feature
      // id absent from the contract ALTOGETHER is the bug class: maternity,
      // calculators and nursing_notes shipped that way, unreachable app-wide.
      final everyHandGrantedId = <String>{
        for (final role in StaffRole.values)
          ...RoleFeatures.getFeaturesForRole(role).map((feature) => feature.id),
      };
      final contractIds = canonicalStaffFeatureRouteRoleCodes.keys.toSet();
      final missing = everyHandGrantedId.difference(contractIds);
      expect(
        missing,
        isEmpty,
        reason:
            'Feature ids granted by role_config but absent from the '
            'generated contract can never render: $missing — add them to '
            'featureRoleSources in scripts/generate-staff-role-contract.mjs '
            'and regenerate.',
      );
    });
  });

  // ─── one staff feature vocabulary ─────────────────────────────────────────
  //
  // The desktop rail is filtered by GET /api/v1/rbac/policy's
  // staff_features_by_role, which names features in the SAME vocabulary as the
  // generated contract. It drifted: this rail's Staff Roster item declared
  // `staff_roster_hub` (the screen's name) where every policy source says
  // `staff_roster`, and `payroll` was in the contract but in neither the
  // backend's feature catalog nor any role entry. Once a policy loaded, both
  // destinations disappeared for roles that hold them. The backend half of this
  // invariant is enforced by assertOneStaffFeatureVocabulary in
  // scripts/generate-staff-role-contract.mjs, which the generated-contract CI
  // gate already runs; these are the client half.
  group('workbench rail feature vocabulary', () {
    test('every rail feature id has a contract entry — an id no policy source '
        'knows is read as a denial and hides the destination', () {
      final railIds = <String>{
        for (final role in StaffRole.values)
          ...RoleFeatures.getWorkbenchNavForRole(role)
              .map((item) => item.featureId)
              .whereType<String>(),
      };
      final contractIds = canonicalStaffFeatureRouteRoleCodes.keys.toSet();
      final unknown = railIds.difference(contractIds);
      expect(
        unknown,
        isEmpty,
        reason:
            'WorkbenchNavItem.featureId values with no generated-contract '
            'entry: $unknown — the role policy cannot grant an id it does not '
            'know, so the rail hides these once a policy loads. Use the '
            'contract id, or add the feature to featureRoleSources in '
            'scripts/generate-staff-role-contract.mjs and regenerate.',
      );
    });

    test('a role policy narrows the rail only inside the vocabulary it '
        'publishes', () {
      const role = StaffRole.admin;
      const rawRole = 'ADMIN';
      final railIds = RoleFeatures.getWorkbenchNavForRole(
        role,
        rawRole: rawRole,
      ).map((item) => item.featureId).whereType<String>().toSet();

      // Both destinations the live backend map omitted entirely.
      expect(railIds, containsAll(['payroll', 'staff_roster']));

      // A snapshot that declares neither `payroll` nor `staff_roster`, and
      // that withholds `audit_logs` from a vocabulary it does declare.
      final published = railIds.difference({'payroll', 'staff_roster'});
      final grantedToRole = published.difference({'audit_logs'});
      final filtered = RoleFeatures.getWorkbenchNavForRole(
        role,
        rawRole: rawRole,
        policyFeatureIds: grantedToRole,
        policyKnownFeatureIds: published,
      ).map((item) => item.featureId).whereType<String>().toSet();

      expect(
        filtered,
        containsAll(['payroll', 'staff_roster']),
        reason:
            'A feature id the policy snapshot never publishes carries no '
            'verdict — treating its absence as a denial is what hid Payroll '
            'and Staff Roster from roles that hold them.',
      );
      expect(
        filtered,
        isNot(contains('audit_logs')),
        reason:
            'The policy must still narrow inside its own vocabulary, or it '
            'stops being a filter at all.',
      );

      // A snapshot with no feature catalog cannot say what it knows, so the
      // static role map plus the generated contract stay the only authority.
      final withoutCatalog = RoleFeatures.getWorkbenchNavForRole(
        role,
        rawRole: rawRole,
        policyFeatureIds: grantedToRole,
      ).map((item) => item.featureId).whereType<String>().toSet();
      expect(withoutCatalog, containsAll(railIds));
    });
  });

  // ─── primary navigation must be reachable ─────────────────────────────────
  group('bottom-nav Work tab', () {
    test('opens a destination its own role can actually reach, and is never a '
        'second copy of Home', () {
      for (final role in StaffRole.values) {
        final items = RoleFeatures.getBottomNavForRole(role);
        final homeRoutes = items
            .where((item) => item.labelKey == 'role.nav.home')
            .map((item) => item.route)
            .toSet();
        final workTabs = items
            .where((item) => item.labelKey == 'role.nav.work')
            .toList();
        for (final tab in workTabs) {
          expect(
            homeRoutes,
            isNot(contains(tab.route)),
            reason:
                '${role.value} Work tab repeats the Home destination '
                '${tab.route} — tapping it never leaves the dashboard and the '
                'selected indicator stays on Home.',
          );
        }
        // An arm may offer SEVERAL Work candidates when one StaffRole is the
        // presentation archetype for backend roles with disjoint grants
        // (ER_STAFF holds ed_trauma_workbench and not sos_response;
        // EMERGENCY_RESPONDER is the exact inverse). The shell filters by
        // reachability, so the invariant is that AT LEAST ONE candidate is
        // reachable — requiring every candidate to be reachable would forbid
        // serving both roles at all, which is what emptied the tab before.
        if (workTabs.isNotEmpty) {
          expect(
            workTabs.any(
              (tab) => StaffRoutePolicy.authorize(
                Uri.parse(tab.route),
                rawRole: role.value,
              ).allowed,
            ),
            isTrue,
            reason:
                '${role.value} has a Work tab but the route policy denies '
                'every candidate (${workTabs.map((t) => t.route).join(", ")}) '
                '— the shell drops them all and a primary navigation slot '
                'silently disappears.',
          );
        }
      }
    });
  });

  // ─── ED / trauma roster ───────────────────────────────────────────────────
  group('ED trauma workbench roster', () {
    test('is granted only to roles the canonical contract admits', () {
      final edRoster =
          canonicalStaffFeatureRouteRoleCodes['ed_trauma_workbench']!;
      final overGranted = <String>[];
      for (final role in StaffRole.values) {
        final granted = RoleFeatures.getFeaturesForRole(role)
            .any((feature) => feature.id == 'ed_trauma_workbench');
        if (granted && !edRoster.contains(role.value)) {
          overGranted.add(role.value);
        }
      }
      expect(
        overGranted,
        isEmpty,
        reason:
            'role_config grants the ED/trauma workbench to $overGranted, which '
            'ED_ROUTE_ROLES denies. The workbench writes STEMI/trauma '
            'activations, ABCDE surveys and MLC records, so the roster is the '
            'backend gate — an inert grant here just opens a screen that 403s.',
      );
      // The roles the ED workbench is actually for keep it.
      for (final role in [
        StaffRole.doctor,
        StaffRole.dutyDoctor,
        StaffRole.nurse,
        StaffRole.ipStaffNurse,
        StaffRole.nursingIncharge,
        StaffRole.ipIncharge,
      ]) {
        expect(
          RoleFeatures.getFeaturesForRole(role).map((feature) => feature.id),
          contains('ed_trauma_workbench'),
          reason: '${role.value} lost the ED/trauma workbench',
        );
      }
    });
  });
}
