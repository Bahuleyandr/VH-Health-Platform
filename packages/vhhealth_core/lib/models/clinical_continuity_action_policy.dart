import 'package:flutter/foundation.dart';

import 'clinical_continuity.dart';

enum ClinicalContinuityActionDisposition {
  queueableCapture('queueable_capture'),
  localDraftOnly('local_draft_only'),
  paperOnlyBackfill('paper_only_backfill'),
  blockedElectronic('blocked_electronic'),
  defaultDeny('default_deny');

  const ClinicalContinuityActionDisposition(this.wireName);

  final String wireName;

  static ClinicalContinuityActionDisposition? fromWireName(Object? value) {
    for (final disposition in values) {
      if (disposition.wireName == value) return disposition;
    }
    return null;
  }
}

@immutable
class ClinicalContinuityActionRule {
  const ClinicalContinuityActionRule({
    required this.actionId,
    required this.disposition,
    required this.captureReady,
    required this.actionVersion,
    required this.actionChecksum,
    required this.actionSchemaId,
    required this.actionSchemaVersion,
    required this.actionSchemaChecksum,
    required this.allowedRoles,
    required this.requiredCapabilityGroups,
  });

  final String actionId;
  final ClinicalContinuityActionDisposition disposition;
  final bool captureReady;
  final int actionVersion;
  final String actionChecksum;
  final String actionSchemaId;
  final int actionSchemaVersion;
  final String? actionSchemaChecksum;
  final Set<String> allowedRoles;
  final Set<String> requiredCapabilityGroups;

  bool get isQueueable =>
      disposition == ClinicalContinuityActionDisposition.queueableCapture;

  bool get isLocalDraftOnly =>
      disposition == ClinicalContinuityActionDisposition.localDraftOnly;
}

@immutable
class ClinicalContinuityCompatibilityRule {
  const ClinicalContinuityCompatibilityRule({
    required this.actionChecksum,
    required this.actionId,
    required this.actionSchemaChecksum,
    required this.actionSchemaVersion,
    required this.actionVersion,
    required this.fromPolicyChecksum,
    required this.fromPolicyEffectiveFrom,
    required this.fromPolicyEffectiveUntil,
    required this.fromPolicyId,
    required this.fromPolicySigningKeyId,
    required this.fromPolicySupersedesId,
    required this.fromPolicyVersion,
    required this.fromRevocationEpoch,
    required this.fromRegistryChecksum,
    required this.fromRegistryVersion,
    required this.maximumCaptureAge,
    required this.outcome,
  });

  final String actionChecksum;
  final String actionId;
  final String? actionSchemaChecksum;
  final int actionSchemaVersion;
  final int actionVersion;
  final String fromPolicyChecksum;
  final DateTime fromPolicyEffectiveFrom;
  final DateTime fromPolicyEffectiveUntil;
  final String fromPolicyId;
  final String fromPolicySigningKeyId;
  final String? fromPolicySupersedesId;
  final String fromPolicyVersion;
  final String fromRevocationEpoch;
  final String fromRegistryChecksum;
  final String fromRegistryVersion;
  final Duration maximumCaptureAge;
  final String outcome;

  bool get allowsReplay => outcome == 'allow';
}

@immutable
class VerifiedClinicalContinuityActionPolicy {
  const VerifiedClinicalContinuityActionPolicy({
    required this.audience,
    required this.policyId,
    required this.policyVersion,
    required this.policyChecksum,
    required this.policySigningKeyId,
    required this.effectiveFrom,
    required this.effectiveUntil,
    required this.policyRevocationEpoch,
    required this.registryVersion,
    required this.registryChecksum,
    required this.activationMode,
    required this.enforcedActionIds,
    required this.allowedDevicePostures,
    required this.minimumAppVersions,
    required this.actions,
    required this.compatibilityRules,
    required this.revokedKeyIds,
    required this.trustedAt,
    this.packCompositionVersion = '2',
    this.policySupersedesId,
  });

  final ClinicalContinuityAudience audience;
  final String policyId;
  final String packCompositionVersion;
  final String policyVersion;
  final String policyChecksum;
  final String policySigningKeyId;
  final DateTime effectiveFrom;
  final DateTime effectiveUntil;
  final String? policySupersedesId;
  final String policyRevocationEpoch;
  final String registryVersion;
  final String registryChecksum;
  final String activationMode;
  final Set<String> enforcedActionIds;
  final Set<String> allowedDevicePostures;
  final Map<String, String> minimumAppVersions;
  final Map<String, ClinicalContinuityActionRule> actions;
  final List<ClinicalContinuityCompatibilityRule> compatibilityRules;
  final Set<String> revokedKeyIds;
  final DateTime trustedAt;

  ClinicalContinuityActionRule? ruleFor(String actionId) => actions[actionId];
}
