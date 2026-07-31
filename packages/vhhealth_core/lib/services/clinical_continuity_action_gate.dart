import 'package:flutter/foundation.dart';

import '../models/clinical_continuity_action_policy.dart';
import '../models/offline_command_envelope.dart';
import 'offline_action_ids.dart';

enum ClinicalContinuityActionGateStage { display, persist, drain, localDraft }

@immutable
class ClinicalContinuityActionContext {
  const ClinicalContinuityActionContext({
    required this.tenantId,
    required this.facilityId,
    required this.devicePosture,
    required this.role,
    required this.capabilityGroups,
    required this.appVersion,
    required this.trustedNow,
  });

  final String tenantId;
  final int facilityId;
  final String devicePosture;
  final String role;
  final Set<String> capabilityGroups;
  final String appVersion;
  final DateTime trustedNow;
}

@immutable
class ClinicalContinuityActionDecision {
  const ClinicalContinuityActionDecision._({
    required this.allowed,
    required this.reasonCode,
    this.policy,
    this.rule,
    this.minimumAppVersion,
    this.trustedNow,
  });

  const ClinicalContinuityActionDecision.denied(String reasonCode)
    : this._(allowed: false, reasonCode: reasonCode);

  const ClinicalContinuityActionDecision.allowed({
    required VerifiedClinicalContinuityActionPolicy policy,
    required ClinicalContinuityActionRule rule,
    required String minimumAppVersion,
    required DateTime trustedNow,
  }) : this._(
         allowed: true,
         reasonCode: 'allowed',
         policy: policy,
         rule: rule,
         minimumAppVersion: minimumAppVersion,
         trustedNow: trustedNow,
       );

  final bool allowed;
  final String reasonCode;
  final VerifiedClinicalContinuityActionPolicy? policy;
  final ClinicalContinuityActionRule? rule;
  final String? minimumAppVersion;
  final DateTime? trustedNow;
}

class ClinicalContinuityActionGate {
  const ClinicalContinuityActionGate();

  ClinicalContinuityActionDecision evaluate({
    required VerifiedClinicalContinuityActionPolicy? policy,
    required String actionId,
    required ClinicalContinuityActionGateStage stage,
    required ClinicalContinuityActionContext context,
  }) {
    if (!OfflineActionIds.isKnown(actionId) ||
        actionId == OfflineActionIds.unknown) {
      return const ClinicalContinuityActionDecision.denied('action_unknown');
    }
    if (policy == null) {
      return const ClinicalContinuityActionDecision.denied(
        'action_policy_unavailable',
      );
    }
    if (policy.audience.tenantId != context.tenantId ||
        policy.audience.facilityId != context.facilityId.toString()) {
      return const ClinicalContinuityActionDecision.denied(
        'action_policy_audience_mismatch',
      );
    }
    final now = context.trustedNow.toUtc();
    if (now.isBefore(policy.effectiveFrom) ||
        !now.isBefore(policy.effectiveUntil)) {
      return const ClinicalContinuityActionDecision.denied(
        'action_policy_not_current',
      );
    }
    if (policy.activationMode != 'enforce' ||
        !policy.enforcedActionIds.contains(actionId)) {
      return const ClinicalContinuityActionDecision.denied(
        'action_not_enforced',
      );
    }
    final posture = context.devicePosture.trim().toLowerCase();
    if (!policy.allowedDevicePostures.contains(posture)) {
      return const ClinicalContinuityActionDecision.denied(
        'device_posture_not_allowed',
      );
    }
    final minimumAppVersion = policy.minimumAppVersions[posture];
    if (minimumAppVersion == null ||
        !_meetsMinimumVersion(context.appVersion, minimumAppVersion)) {
      return const ClinicalContinuityActionDecision.denied(
        'minimum_app_version_not_met',
      );
    }
    final rule = policy.ruleFor(actionId);
    if (rule == null || !rule.captureReady) {
      return const ClinicalContinuityActionDecision.denied(
        'action_not_capture_ready',
      );
    }
    final role = context.role.trim().toUpperCase();
    if (!rule.allowedRoles.contains(role)) {
      return const ClinicalContinuityActionDecision.denied('role_not_allowed');
    }
    if (!context.capabilityGroups.containsAll(rule.requiredCapabilityGroups)) {
      return const ClinicalContinuityActionDecision.denied(
        'capability_not_allowed',
      );
    }

    final dispositionAllowed = switch (stage) {
      ClinicalContinuityActionGateStage.display =>
        rule.isQueueable || rule.isLocalDraftOnly,
      ClinicalContinuityActionGateStage.persist ||
      ClinicalContinuityActionGateStage.drain => rule.isQueueable,
      ClinicalContinuityActionGateStage.localDraft => rule.isLocalDraftOnly,
    };
    if (!dispositionAllowed) {
      return ClinicalContinuityActionDecision.denied(
        'action_${rule.disposition.wireName}',
      );
    }
    if (rule.isQueueable &&
        OfflineActionIds.clientTransportFor(actionId) == null) {
      return const ClinicalContinuityActionDecision.denied(
        'client_transport_unavailable',
      );
    }

    return ClinicalContinuityActionDecision.allowed(
      policy: policy,
      rule: rule,
      minimumAppVersion: minimumAppVersion,
      trustedNow: now,
    );
  }

  ClinicalContinuityActionDecision evaluatePreparedDrain({
    required VerifiedClinicalContinuityActionPolicy? policy,
    required OfflineCommandEnvelope envelope,
    required ClinicalContinuityActionContext context,
  }) {
    final current = evaluate(
      policy: policy,
      actionId: envelope.actionId,
      stage: ClinicalContinuityActionGateStage.drain,
      context: context,
    );
    if (!current.allowed || policy == null) return current;
    final rule = current.rule!;
    final minimumAppVersion = current.minimumAppVersion!;
    final trustedNow = current.trustedNow!;

    final samePolicy =
        envelope.policyId == policy.policyId &&
        envelope.policyVersion == policy.policyVersion &&
        envelope.policyChecksum == policy.policyChecksum &&
        envelope.registryVersion == policy.registryVersion &&
        envelope.registryChecksum == policy.registryChecksum;
    if (samePolicy) {
      return _matchesCurrentAuthority(
            policy: policy,
            rule: rule,
            minimumAppVersion: minimumAppVersion,
            envelope: envelope,
          )
          ? current
          : const ClinicalContinuityActionDecision.denied(
              'action_authority_mismatch',
            );
    }

    if (policy.revokedKeyIds.contains(envelope.policySigningKeyId)) {
      return const ClinicalContinuityActionDecision.denied(
        'capture_policy_untrusted',
      );
    }
    final compatibility = _matchingCompatibilityRule(
      policy: policy,
      currentRule: rule,
      envelope: envelope,
      trustedNow: trustedNow,
    );
    if (compatibility == null) {
      return const ClinicalContinuityActionDecision.denied(
        'action_compatibility_missing',
      );
    }
    if (!compatibility.allowsReplay) {
      return const ClinicalContinuityActionDecision.denied(
        'action_compatibility_review',
      );
    }
    return current;
  }
}

bool _matchesCurrentAuthority({
  required VerifiedClinicalContinuityActionPolicy policy,
  required ClinicalContinuityActionRule rule,
  required String minimumAppVersion,
  required OfflineCommandEnvelope envelope,
}) {
  return envelope.policySigningKeyId == policy.policySigningKeyId &&
      envelope.policyEffectiveFrom.isAtSameMomentAs(policy.effectiveFrom) &&
      envelope.policyEffectiveUntil.isAtSameMomentAs(policy.effectiveUntil) &&
      envelope.policySupersedesId == policy.policySupersedesId &&
      envelope.policyRevocationEpoch == policy.policyRevocationEpoch &&
      envelope.actionVersion == rule.actionVersion &&
      envelope.actionChecksum == rule.actionChecksum &&
      envelope.actionSchemaId == rule.actionSchemaId &&
      envelope.actionSchemaVersion == rule.actionSchemaVersion &&
      envelope.actionSchemaChecksum == rule.actionSchemaChecksum &&
      envelope.minimumAppVersion == minimumAppVersion;
}

ClinicalContinuityCompatibilityRule? _matchingCompatibilityRule({
  required VerifiedClinicalContinuityActionPolicy policy,
  required ClinicalContinuityActionRule currentRule,
  required OfflineCommandEnvelope envelope,
  required DateTime trustedNow,
}) {
  final captureAge = trustedNow.difference(envelope.capturedAt.toUtc());
  if (captureAge.isNegative) return null;
  for (final candidate in policy.compatibilityRules) {
    if (candidate.fromPolicyId == envelope.policyId &&
        candidate.fromPolicyVersion == envelope.policyVersion &&
        candidate.fromPolicyChecksum == envelope.policyChecksum &&
        candidate.fromPolicyEffectiveFrom.isAtSameMomentAs(
          envelope.policyEffectiveFrom,
        ) &&
        candidate.fromPolicyEffectiveUntil.isAtSameMomentAs(
          envelope.policyEffectiveUntil,
        ) &&
        candidate.fromPolicySigningKeyId == envelope.policySigningKeyId &&
        candidate.fromPolicySupersedesId == envelope.policySupersedesId &&
        candidate.fromRevocationEpoch == envelope.policyRevocationEpoch &&
        candidate.fromRegistryVersion == envelope.registryVersion &&
        candidate.fromRegistryChecksum == envelope.registryChecksum &&
        candidate.actionId == envelope.actionId &&
        candidate.actionVersion == envelope.actionVersion &&
        candidate.actionChecksum == envelope.actionChecksum &&
        candidate.actionSchemaVersion == envelope.actionSchemaVersion &&
        candidate.actionSchemaChecksum == envelope.actionSchemaChecksum &&
        candidate.actionId == currentRule.actionId &&
        candidate.actionVersion == currentRule.actionVersion &&
        candidate.actionChecksum == currentRule.actionChecksum &&
        candidate.actionSchemaVersion == currentRule.actionSchemaVersion &&
        candidate.actionSchemaChecksum == currentRule.actionSchemaChecksum &&
        captureAge <= candidate.maximumCaptureAge) {
      return candidate;
    }
  }
  return null;
}

bool _meetsMinimumVersion(String actual, String minimum) {
  final actualParts = _semanticVersion(actual);
  final minimumParts = _semanticVersion(minimum);
  if (actualParts == null || minimumParts == null) return false;
  for (var index = 0; index < actualParts.length; index++) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

List<int>? _semanticVersion(String raw) {
  final match = RegExp(
    r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z.-]+)?$',
  ).firstMatch(raw.trim());
  if (match == null) return null;
  return <int>[
    int.parse(match.group(1)!),
    int.parse(match.group(2)!),
    int.parse(match.group(3)!),
  ];
}
