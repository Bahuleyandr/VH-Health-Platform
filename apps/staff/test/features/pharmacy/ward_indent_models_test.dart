import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/features/pharmacy/models/ward_indent_models.dart';
import 'package:vhhealth_staff/features/pharmacy/services/ward_indent_role_policy.dart';

void main() {
  group('WardIndent', () {
    test(
      'parses quantities, ownership, SLA, events, and recovery evidence',
      () {
        final indent = WardIndent.fromJson({
          'id': 73,
          'indent_number': 'WI-2026-0073',
          'status': 'controlled_handoff_required',
          'state_version': 4,
          'patient_uid': '11111111-1111-4111-8111-111111111111',
          'ward_id': 8,
          'ward_name': 'Ward B',
          'items': [
            {
              'id': 91,
              'pharmacy_catalog_id': 17,
              'item_name': 'Morphine 10 mg',
              'quantity_requested': '2.00',
              'quantity_reserved': '2.00',
              'quantity_approved': '2.00',
              'quantity_issued': '0.00',
              'quantity_received': '0.00',
              'controlled_reference_id': 'ward-indent:73:item:91',
            },
          ],
          'workflow': {
            'owner_role_codes': ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
            'active_slas': [
              {
                'id': 501,
                'status': 'breached',
                'due_at': '2026-08-27T02:00:00.000Z',
              },
            ],
            'events': [
              {
                'id': 601,
                'action': 'approved',
                'from_status': 'reserved',
                'to_status': 'controlled_handoff_required',
                'state_version': 4,
                'occurred_at': '2026-08-27T01:45:00.000Z',
              },
            ],
            'pending_controlled_handoff_evidence': [
              {
                'item_id': 91,
                'status': 'available',
                'candidate_count': 1,
                'movement_id': 701,
                'register_id': 801,
              },
            ],
          },
        });

        expect(indent.id, 73);
        expect(indent.status, WardIndentStatus.controlledHandoffRequired);
        expect(indent.stateVersion, 4);
        expect(indent.items.single.quantityApproved, 2);
        expect(indent.items.single.isControlled, isTrue);
        expect(indent.ownerRoleCodes, contains('PHARMACY_STAFF'));
        expect(indent.isOverdue, isTrue);
        expect(indent.events.single.action, 'approved');
        expect(indent.controlledRecovery.single.isRecoverable, isTrue);
        expect(indent.controlledRecovery.single.movementId, 701);
      },
    );

    test(
      'keeps unknown server states fail-closed and identifies terminals',
      () {
        final unknown = WardIndent.fromJson({
          'id': 1,
          'status': 'future_state',
          'state_version': 1,
          'items': const [],
        });
        final closed = WardIndent.fromJson({
          'id': 2,
          'status': 'closed',
          'state_version': 9,
          'items': const [],
        });

        expect(unknown.status, WardIndentStatus.unknown);
        expect(unknown.isTerminal, isFalse);
        expect(closed.isTerminal, isTrue);
      },
    );
  });

  group('WardIndentRolePolicy', () {
    WardIndent indent(String status) => WardIndent.fromJson({
      'id': 73,
      'status': status,
      'state_version': 2,
      'items': const [],
    });

    WardIndent controlledIndent({required bool recoverable}) =>
        WardIndent.fromJson({
          'id': 73,
          'status': 'controlled_handoff_required',
          'state_version': 4,
          'items': [
            {
              'id': 91,
              'item_name': 'Morphine 10 mg',
              'controlled_reference_id': 'ward-indent:73:item:91',
            },
          ],
          'workflow': {
            'pending_controlled_handoff_evidence': [
              {
                'item_id': 91,
                'status': recoverable ? 'available' : 'missing',
                'candidate_count': recoverable ? 1 : 0,
                if (recoverable) 'movement_id': 701,
                if (recoverable) 'register_id': 801,
              },
            ],
          },
        });

    test(
      'pharmacy supply roles own reserve through issue, not ward receipt',
      () {
        expect(
          WardIndentRolePolicy.actionsFor(
            indent('requested'),
            rawRole: 'PHARMACY_STAFF',
            role: StaffRole.pharmacy,
          ),
          containsAll({
            WardIndentAction.reserve,
            WardIndentAction.shortSupply,
            WardIndentAction.reject,
            WardIndentAction.cancel,
          }),
        );
        expect(
          WardIndentRolePolicy.actionsFor(
            indent('issued'),
            rawRole: 'PHARMACY_STAFF',
            role: StaffRole.pharmacy,
          ),
          isNot(contains(WardIndentAction.receive)),
        );
      },
    );

    test('doctor tiers decide substitutions but cannot supply stock', () {
      final actions = WardIndentRolePolicy.actionsFor(
        indent('substitution_pending'),
        rawRole: 'CONSULTANT',
        role: StaffRole.doctor,
      );
      expect(
        actions,
        containsAll({
          WardIndentAction.approveSubstitution,
          WardIndentAction.rejectSubstitution,
          WardIndentAction.cancel,
        }),
      );
      expect(actions, isNot(contains(WardIndentAction.approve)));
    });

    test(
      'ward nurses receive and report discrepancies but cannot reconcile',
      () {
        final actions = WardIndentRolePolicy.actionsFor(
          indent('issued'),
          rawRole: 'IP_STAFF_NURSE',
          role: StaffRole.ipStaffNurse,
        );
        expect(
          actions,
          containsAll({WardIndentAction.receive, WardIndentAction.discrepancy}),
        );
        expect(actions, isNot(contains(WardIndentAction.reconcile)));
      },
    );

    test(
      'ER and supply-chain owners can work their backend-authorized legs',
      () {
        expect(
          WardIndentRolePolicy.actionsFor(
            indent('issued'),
            rawRole: 'ER_STAFF',
            role: StaffRole.fromString('ER_STAFF'),
          ),
          containsAll({WardIndentAction.receive, WardIndentAction.discrepancy}),
        );
        expect(
          WardIndentRolePolicy.actionsFor(
            indent('requested'),
            rawRole: 'STORES_PURCHASE_INCHARGE',
            role: StaffRole.storesPurchaseIncharge,
          ),
          containsAll({WardIndentAction.reserve, WardIndentAction.shortSupply}),
        );
        expect(
          WardIndentRolePolicy.actionsFor(
            indent('requested'),
            rawRole: 'STORES_PURCHASE_INCHARGE',
            role: StaffRole.storesPurchaseIncharge,
          ),
          isNot(contains(WardIndentAction.cancel)),
        );
      },
    );

    test(
      'stores can record exact controlled recovery but cannot start dispensing',
      () {
        expect(
          WardIndentRolePolicy.actionsFor(
            controlledIndent(recoverable: false),
            rawRole: 'STORES_PURCHASE_INCHARGE',
            role: StaffRole.storesPurchaseIncharge,
          ),
          isNot(contains(WardIndentAction.controlledHandoff)),
        );
        expect(
          WardIndentRolePolicy.actionsFor(
            controlledIndent(recoverable: true),
            rawRole: 'STORES_PURCHASE_INCHARGE',
            role: StaffRole.storesPurchaseIncharge,
          ),
          contains(WardIndentAction.controlledHandoff),
        );
        expect(
          WardIndentRolePolicy.actionsFor(
            controlledIndent(recoverable: false),
            rawRole: 'PHARMACIST',
            role: StaffRole.pharmacy,
          ),
          contains(WardIndentAction.controlledHandoff),
        );
      },
    );

    test('recognized role aliases use their canonical backend archetype', () {
      expect(
        WardIndentRolePolicy.actionsFor(
          indent('requested'),
          rawRole: 'MATERIALS_MANAGER',
          role: StaffRole.fromString('MATERIALS_MANAGER'),
        ),
        contains(WardIndentAction.reserve),
      );
    });

    test('in-charge roles reconcile and close only in valid states', () {
      expect(
        WardIndentRolePolicy.actionsFor(
          indent('reconciliation_required'),
          rawRole: 'IP_INCHARGE',
          role: StaffRole.ipIncharge,
        ),
        contains(WardIndentAction.reconcile),
      );
      expect(
        WardIndentRolePolicy.actionsFor(
          indent('received'),
          rawRole: 'IP_INCHARGE',
          role: StaffRole.ipIncharge,
        ),
        contains(WardIndentAction.close),
      );
    });

    test('unknown and read-only roles never inherit lifecycle actions', () {
      expect(
        WardIndentRolePolicy.actionsFor(
          indent('requested'),
          rawRole: 'UNKNOWN_NEW_ROLE',
          role: StaffRole.general,
        ),
        isEmpty,
      );
      expect(
        WardIndentRolePolicy.actionsFor(
          indent('requested'),
          rawRole: 'ADMISSION_OFFICER',
          role: StaffRole.admissionOfficer,
        ),
        equals({WardIndentAction.cancel}),
      );
    });
  });
}
