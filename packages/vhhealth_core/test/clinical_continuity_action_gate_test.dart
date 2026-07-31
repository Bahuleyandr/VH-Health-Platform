import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/clinical_continuity.dart';
import 'package:vhhealth_core/models/clinical_continuity_action_policy.dart';
import 'package:vhhealth_core/models/offline_command_envelope.dart';
import 'package:vhhealth_core/services/clinical_continuity_action_gate.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';

void main() {
  const gate = ClinicalContinuityActionGate();
  final now = DateTime.utc(2026, 7, 31, 12);

  ClinicalContinuityActionDecision decide({
    VerifiedClinicalContinuityActionPolicy? policy,
    String actionId = OfflineActionIds.nursingNoteDraftStore,
    ClinicalContinuityActionGateStage stage =
        ClinicalContinuityActionGateStage.persist,
    String tenantId = 'tenant-1',
    int facilityId = 41,
    String posture = 'desktop',
    String role = 'NURSING_STAFF',
    Set<String> capabilities = const {'clinical_notes'},
    String appVersion = '1.2.0+4',
  }) {
    return gate.evaluate(
      policy: policy,
      actionId: actionId,
      stage: stage,
      context: ClinicalContinuityActionContext(
        tenantId: tenantId,
        facilityId: facilityId,
        devicePosture: posture,
        role: role,
        capabilityGroups: capabilities,
        appVersion: appVersion,
        trustedNow: now,
      ),
    );
  }

  test(
    'fails closed for unavailable, unknown, and wrong-audience authority',
    () {
      expect(decide().reasonCode, 'action_policy_unavailable');
      expect(
        decide(
          policy: _policy(now),
          actionId: OfflineActionIds.unknown,
        ).reasonCode,
        'action_unknown',
      );
      expect(
        decide(policy: _policy(now), tenantId: 'other').reasonCode,
        'action_policy_audience_mismatch',
      );
      expect(
        decide(policy: _policy(now), facilityId: 42).reasonCode,
        'action_policy_audience_mismatch',
      );
    },
  );

  test('enforces signed activation, time, posture, and minimum version', () {
    expect(
      decide(policy: _policy(now, mode: 'shadow')).reasonCode,
      'action_not_enforced',
    );
    expect(
      decide(policy: _policy(now, effectiveUntil: now)).reasonCode,
      'action_policy_not_current',
    );
    expect(
      decide(policy: _policy(now), posture: 'phone').reasonCode,
      'device_posture_not_allowed',
    );
    expect(
      decide(policy: _policy(now), appVersion: '1.1.99+999').reasonCode,
      'minimum_app_version_not_met',
    );
    expect(
      decide(policy: _policy(now), appVersion: 'invalid').reasonCode,
      'minimum_app_version_not_met',
    );
  });

  test('enforces capture readiness, role, and capability membership', () {
    expect(
      decide(policy: _policy(now, captureReady: false)).reasonCode,
      'action_not_capture_ready',
    );
    expect(
      decide(policy: _policy(now), role: 'DOCTOR').reasonCode,
      'role_not_allowed',
    );
    expect(
      decide(policy: _policy(now), capabilities: const {}).reasonCode,
      'capability_not_allowed',
    );
  });

  test(
    'allows queue persistence and drain only for compiled transport IDs',
    () {
      final policy = _policy(now);
      for (final stage in [
        ClinicalContinuityActionGateStage.display,
        ClinicalContinuityActionGateStage.persist,
        ClinicalContinuityActionGateStage.drain,
      ]) {
        final decision = decide(policy: policy, stage: stage);
        expect(decision.allowed, isTrue);
        expect(decision.minimumAppVersion, '1.2.0');
        expect(decision.trustedNow, now);
      }

      final noTransport = _policy(
        now,
        actionId: OfflineActionIds.vitalsCapture,
      );
      expect(
        decide(
          policy: noTransport,
          actionId: OfflineActionIds.vitalsCapture,
        ).reasonCode,
        'client_transport_unavailable',
      );
    },
  );

  test(
    'local drafts can display and persist locally but never queue or drain',
    () {
      final policy = _policy(
        now,
        actionId: OfflineActionIds.opPrescriptionDraft,
        disposition: ClinicalContinuityActionDisposition.localDraftOnly,
      );

      expect(
        decide(
          policy: policy,
          actionId: OfflineActionIds.opPrescriptionDraft,
          stage: ClinicalContinuityActionGateStage.display,
        ).allowed,
        isTrue,
      );
      expect(
        decide(
          policy: policy,
          actionId: OfflineActionIds.opPrescriptionDraft,
          stage: ClinicalContinuityActionGateStage.localDraft,
        ).allowed,
        isTrue,
      );
      for (final stage in [
        ClinicalContinuityActionGateStage.persist,
        ClinicalContinuityActionGateStage.drain,
      ]) {
        expect(
          decide(
            policy: policy,
            actionId: OfflineActionIds.opPrescriptionDraft,
            stage: stage,
          ).reasonCode,
          'action_local_draft_only',
        );
      }
    },
  );

  test('prepared drain requires every pinned current-authority claim', () {
    final policy = _policy(now);
    final context = _context(now);
    expect(
      gate
          .evaluatePreparedDrain(
            policy: policy,
            envelope: _envelope(policy, capturedAt: now),
            context: context,
          )
          .allowed,
      isTrue,
    );
    expect(
      gate
          .evaluatePreparedDrain(
            policy: policy,
            envelope: _envelope(
              policy,
              capturedAt: now,
              actionChecksum: 'f' * 64,
            ),
            context: context,
          )
          .reasonCode,
      'action_authority_mismatch',
    );
  });

  test('prepared drain needs an exact signed compatibility rule', () {
    final capturedPolicy = _policy(
      now,
      policyId: 'captured-policy',
      policyVersion: '6',
      policyChecksum: 'e' * 64,
      policySigningKeyId: 'captured-key',
      registryVersion: '4',
      registryChecksum: 'f' * 64,
    );
    final envelope = _envelope(
      capturedPolicy,
      capturedAt: now.subtract(const Duration(minutes: 10)),
    );
    final context = _context(now);
    expect(
      gate
          .evaluatePreparedDrain(
            policy: _policy(now),
            envelope: envelope,
            context: context,
          )
          .reasonCode,
      'action_compatibility_missing',
    );

    final review = _compatibility(envelope, outcome: 'needs_review');
    expect(
      gate
          .evaluatePreparedDrain(
            policy: _policy(now, compatibilityRules: [review]),
            envelope: envelope,
            context: context,
          )
          .reasonCode,
      'action_compatibility_review',
    );

    final allow = _compatibility(envelope, outcome: 'allow');
    expect(
      gate
          .evaluatePreparedDrain(
            policy: _policy(now, compatibilityRules: [allow]),
            envelope: envelope,
            context: context,
          )
          .allowed,
      isTrue,
    );
    expect(
      gate
          .evaluatePreparedDrain(
            policy: _policy(
              now,
              compatibilityRules: [
                _compatibility(
                  envelope,
                  outcome: 'allow',
                  maximumCaptureAge: const Duration(minutes: 5),
                ),
              ],
            ),
            envelope: envelope,
            context: context,
          )
          .reasonCode,
      'action_compatibility_missing',
    );
    expect(
      gate
          .evaluatePreparedDrain(
            policy: _policy(now, revokedKeyIds: const {'captured-key'}),
            envelope: envelope,
            context: context,
          )
          .reasonCode,
      'capture_policy_untrusted',
    );
  });
}

ClinicalContinuityActionContext _context(DateTime now) {
  return ClinicalContinuityActionContext(
    tenantId: 'tenant-1',
    facilityId: 41,
    devicePosture: 'desktop',
    role: 'NURSING_STAFF',
    capabilityGroups: const {'clinical_notes'},
    appVersion: '1.2.0+4',
    trustedNow: now,
  );
}

VerifiedClinicalContinuityActionPolicy _policy(
  DateTime now, {
  String actionId = OfflineActionIds.nursingNoteDraftStore,
  ClinicalContinuityActionDisposition disposition =
      ClinicalContinuityActionDisposition.queueableCapture,
  String mode = 'enforce',
  bool captureReady = true,
  DateTime? effectiveUntil,
  String policyId = 'policy-1',
  String policyVersion = '7',
  String? policyChecksum,
  String policySigningKeyId = 'policy-key-1',
  String registryVersion = '5',
  String? registryChecksum,
  List<ClinicalContinuityCompatibilityRule> compatibilityRules = const [],
  Set<String> revokedKeyIds = const {},
}) {
  final rule = ClinicalContinuityActionRule(
    actionId: actionId,
    disposition: disposition,
    captureReady: captureReady,
    actionVersion: 1,
    actionChecksum: 'a' * 64,
    actionSchemaId: '$actionId.v1',
    actionSchemaVersion: 1,
    actionSchemaChecksum: 'b' * 64,
    allowedRoles: const {'NURSING_STAFF'},
    requiredCapabilityGroups: const {'clinical_notes'},
  );
  return VerifiedClinicalContinuityActionPolicy(
    audience: const ClinicalContinuityAudience(
      tenantId: 'tenant-1',
      facilityId: '41',
    ),
    policyId: policyId,
    policyVersion: policyVersion,
    policyChecksum: policyChecksum ?? 'c' * 64,
    policySigningKeyId: policySigningKeyId,
    effectiveFrom: now.subtract(const Duration(hours: 1)),
    effectiveUntil: effectiveUntil ?? now.add(const Duration(hours: 1)),
    policyRevocationEpoch: '3',
    registryVersion: registryVersion,
    registryChecksum: registryChecksum ?? 'd' * 64,
    activationMode: mode,
    enforcedActionIds: {actionId},
    allowedDevicePostures: const {'desktop'},
    minimumAppVersions: const {'desktop': '1.2.0'},
    actions: {actionId: rule},
    compatibilityRules: compatibilityRules,
    revokedKeyIds: revokedKeyIds,
    trustedAt: now,
  );
}

OfflineCommandEnvelope _envelope(
  VerifiedClinicalContinuityActionPolicy policy, {
  required DateTime capturedAt,
  String? actionChecksum,
}) {
  final rule = policy.ruleFor(OfflineActionIds.nursingNoteDraftStore)!;
  return OfflineCommandEnvelope(
    clientEventId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
    actionId: rule.actionId,
    commandFingerprint: 'fingerprint',
    payloadHash: 'payload-hash',
    appVersion: '1.2.0+4',
    envelopeSchemaVersion: OfflineCommandEnvelope.schemaVersion,
    queueSchemaVersion: 6,
    actionVersion: rule.actionVersion,
    actionChecksum: actionChecksum ?? rule.actionChecksum,
    actionSchemaId: rule.actionSchemaId,
    actionSchemaVersion: rule.actionSchemaVersion,
    actionSchemaChecksum: rule.actionSchemaChecksum!,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    policyChecksum: policy.policyChecksum,
    policySigningKeyId: policy.policySigningKeyId,
    policyEffectiveFrom: policy.effectiveFrom,
    policyEffectiveUntil: policy.effectiveUntil,
    policySupersedesId: policy.policySupersedesId,
    policyRevocationEpoch: policy.policyRevocationEpoch,
    registryVersion: policy.registryVersion,
    registryChecksum: policy.registryChecksum,
    minimumAppVersion: policy.minimumAppVersions['desktop']!,
    tenantId: 'tenant-1',
    facilityId: 41,
    deviceId: 'device-1',
    devicePosture: 'desktop',
    captureSessionId: '33333333-3333-4333-8333-333333333333',
    captureActorUuid: '44444444-4444-4444-8444-444444444444',
    captureRole: 'NURSING_STAFF',
    patientReference: 'patient-1',
    occurredAt: capturedAt,
    capturedAt: capturedAt,
    queuedAt: capturedAt.add(const Duration(seconds: 1)),
    clockEvidence: OfflineClockEvidence(
      observedAt: capturedAt,
      serverTime: capturedAt,
      midpoint: capturedAt,
      skewMilliseconds: 0,
      uncertaintyMilliseconds: 0,
      toleranceMilliseconds: 30000,
      routeKind: 'signed_policy',
    ),
    cachedSources: {'patient_identity': capturedAt},
    expiresAt: policy.effectiveUntil,
    orderingKey: 'tenant-1\u0000patient-1\u0000note',
    orderingKeyDigest: 'ordering-digest',
    sequence: 1,
    supersessionGeneration: 0,
    humanReviewRequired: false,
  );
}

ClinicalContinuityCompatibilityRule _compatibility(
  OfflineCommandEnvelope envelope, {
  required String outcome,
  Duration maximumCaptureAge = const Duration(minutes: 30),
}) {
  return ClinicalContinuityCompatibilityRule(
    actionChecksum: envelope.actionChecksum,
    actionId: envelope.actionId,
    actionSchemaChecksum: envelope.actionSchemaChecksum,
    actionSchemaVersion: envelope.actionSchemaVersion,
    actionVersion: envelope.actionVersion,
    fromPolicyChecksum: envelope.policyChecksum,
    fromPolicyEffectiveFrom: envelope.policyEffectiveFrom,
    fromPolicyEffectiveUntil: envelope.policyEffectiveUntil,
    fromPolicyId: envelope.policyId,
    fromPolicySigningKeyId: envelope.policySigningKeyId,
    fromPolicySupersedesId: envelope.policySupersedesId,
    fromPolicyVersion: envelope.policyVersion,
    fromRevocationEpoch: envelope.policyRevocationEpoch,
    fromRegistryChecksum: envelope.registryChecksum,
    fromRegistryVersion: envelope.registryVersion,
    maximumCaptureAge: maximumCaptureAge,
    outcome: outcome,
  );
}
