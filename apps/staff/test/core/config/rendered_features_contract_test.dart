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

Set<String> renderedIds(String rawRole) =>
    RoleFeatures.getFeaturesForRawRole(rawRole)
        .map((feature) => feature.id)
        .toSet();

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
}
