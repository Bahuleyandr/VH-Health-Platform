import '../../../core/config/role_config.dart';
import '../../../core/config/ward_indent_role_contract.dart';
import '../models/ward_indent_models.dart';

enum WardIndentAction {
  reserve,
  shortSupply,
  proposeSubstitution,
  approveSubstitution,
  applyApprovedSubstitution,
  rejectSubstitution,
  approve,
  reject,
  controlledHandoff,
  issue,
  receive,
  requestReturn,
  discrepancy,
  reconcile,
  cancel,
  close,
}

extension WardIndentActionContract on WardIndentAction {
  String get apiPath => switch (this) {
    WardIndentAction.reserve => 'reserve',
    WardIndentAction.shortSupply => 'short-supply',
    WardIndentAction.proposeSubstitution => 'substitutions',
    WardIndentAction.approveSubstitution => 'substitutions/approve',
    WardIndentAction.applyApprovedSubstitution => 'substitutions/apply',
    WardIndentAction.rejectSubstitution => 'substitutions/reject',
    WardIndentAction.approve => 'approve',
    WardIndentAction.reject => 'reject',
    WardIndentAction.controlledHandoff => 'controlled-handoff',
    WardIndentAction.issue => 'issue',
    WardIndentAction.receive => 'receive',
    WardIndentAction.requestReturn => 'returns',
    WardIndentAction.discrepancy => 'discrepancies',
    WardIndentAction.reconcile => 'reconcile',
    WardIndentAction.cancel => 'cancel',
    WardIndentAction.close => 'close',
  };
}

abstract final class WardIndentRolePolicy {
  static bool canRead({required String rawRole, required StaffRole role}) {
    return WardIndentRoleContract.canRead(rawRole: rawRole, role: role);
  }

  static Set<WardIndentAction> actionsFor(
    WardIndent indent, {
    required String rawRole,
    required StaffRole role,
  }) {
    final roleCode = WardIndentRoleContract.canonicalRoleCode(rawRole, role);
    if (!WardIndentRoleContract.readRoleCodes.contains(roleCode) ||
        indent.status.isTerminal) {
      return const {};
    }

    final actions = <WardIndentAction>{};
    if (WardIndentRoleContract.supplyRoleCodes.contains(roleCode)) {
      switch (indent.status) {
        case WardIndentStatus.requested:
          actions.addAll({
            WardIndentAction.reserve,
            WardIndentAction.shortSupply,
            WardIndentAction.reject,
          });
          break;
        case WardIndentStatus.reserved:
          actions.addAll({
            WardIndentAction.shortSupply,
            WardIndentAction.approve,
            WardIndentAction.reject,
          });
          break;
        case WardIndentStatus.shortSupply:
          actions.addAll({
            WardIndentAction.reserve,
            WardIndentAction.shortSupply,
            WardIndentAction.proposeSubstitution,
            WardIndentAction.reject,
          });
          break;
        case WardIndentStatus.substitutionPending:
          if (indent.items.any(
                (item) => item.substitutionStatus == 'approved',
              ) &&
              !indent.items.any(
                (item) => item.substitutionStatus == 'pending',
              )) {
            actions.add(WardIndentAction.applyApprovedSubstitution);
          }
          actions.add(WardIndentAction.reject);
          break;
        case WardIndentStatus.controlledHandoffRequired:
          if (_canPerformControlledHandoff(indent, roleCode)) {
            actions.add(WardIndentAction.controlledHandoff);
          }
          actions.add(WardIndentAction.reject);
          break;
        case WardIndentStatus.approved:
          actions.addAll({WardIndentAction.issue, WardIndentAction.reject});
          break;
        default:
          break;
      }
    }

    if (WardIndentRoleContract.substitutionDecisionRoleCodes.contains(
          roleCode,
        ) &&
        indent.status == WardIndentStatus.substitutionPending) {
      actions.addAll({
        WardIndentAction.approveSubstitution,
        WardIndentAction.rejectSubstitution,
      });
    }

    if (WardIndentRoleContract.wardReceiptRoleCodes.contains(roleCode)) {
      if (const {
        WardIndentStatus.issued,
        WardIndentStatus.partiallyReceived,
      }.contains(indent.status)) {
        actions.add(WardIndentAction.receive);
      }
      if (const {
        WardIndentStatus.partiallyReceived,
        WardIndentStatus.received,
      }.contains(indent.status)) {
        actions.add(WardIndentAction.requestReturn);
      }
      if (const {
        WardIndentStatus.issued,
        WardIndentStatus.partiallyReceived,
        WardIndentStatus.received,
        WardIndentStatus.returnPending,
      }.contains(indent.status)) {
        actions.add(WardIndentAction.discrepancy);
      }
    }

    if (WardIndentRoleContract.reconciliationRoleCodes.contains(roleCode)) {
      if (const {
        WardIndentStatus.returnPending,
        WardIndentStatus.reconciliationRequired,
      }.contains(indent.status)) {
        actions.add(WardIndentAction.reconcile);
      }
      if (const {
        WardIndentStatus.received,
        WardIndentStatus.reconciled,
      }.contains(indent.status)) {
        actions.add(WardIndentAction.close);
      }
    }

    if (WardIndentRoleContract.requestRoleCodes.contains(roleCode) &&
        const {
          WardIndentStatus.requested,
          WardIndentStatus.reserved,
          WardIndentStatus.shortSupply,
          WardIndentStatus.substitutionPending,
          WardIndentStatus.controlledHandoffRequired,
          WardIndentStatus.approved,
        }.contains(indent.status)) {
      actions.add(WardIndentAction.cancel);
    }
    return actions;
  }

  static bool _canPerformControlledHandoff(WardIndent indent, String roleCode) {
    if (!WardIndentRoleContract.controlledDispenseRoleCodes.contains(
      roleCode,
    )) {
      return false;
    }
    final controlledItemIds = indent.items
        .where((item) => item.isControlled)
        .map((item) => item.id)
        .toSet();
    if (controlledItemIds.isEmpty ||
        indent.controlledRecovery.any(
          (recovery) => !controlledItemIds.contains(recovery.itemId),
        )) {
      return false;
    }

    for (final itemId in controlledItemIds) {
      final recoveries = indent.controlledRecovery
          .where((recovery) => recovery.itemId == itemId)
          .toList(growable: false);
      if (recoveries.length != 1) return false;
      final recovery = recoveries.single;
      final isFresh =
          recovery.status == 'missing' &&
          recovery.candidateCount == 0 &&
          recovery.movementId == null &&
          recovery.registerId == null;
      if (isFresh) continue;
      final isExactHistorical =
          recovery.isRecoverable &&
          recovery.movementId! > 0 &&
          recovery.registerId! > 0;
      if (!isExactHistorical || roleCode != 'PHARMACY_INCHARGE') return false;
    }
    return true;
  }
}
