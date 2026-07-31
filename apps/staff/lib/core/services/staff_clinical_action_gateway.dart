import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/models/offline_command_envelope.dart';
import 'package:vhhealth_core/services/clinical_continuity_action_gate.dart';
import 'package:vhhealth_core/services/clinical_local_draft_store.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';

import 'staff_action_policy_repository.dart';
import 'staff_offline_capture_context.dart';

enum StaffCaptureCallSite {
  nursingAssessmentDraftStorage,
  opConsultationDraftStorage,
  opPrescriptionLocalDraft,
  ipDrugChartLocalDraft,
}

extension StaffCaptureCallSiteContract on StaffCaptureCallSite {
  String get actionId => switch (this) {
    StaffCaptureCallSite.nursingAssessmentDraftStorage =>
      OfflineActionIds.nursingNoteDraftStore,
    StaffCaptureCallSite.opConsultationDraftStorage =>
      OfflineActionIds.opNoteDraftStore,
    StaffCaptureCallSite.opPrescriptionLocalDraft =>
      OfflineActionIds.opPrescriptionDraft,
    StaffCaptureCallSite.ipDrugChartLocalDraft =>
      OfflineActionIds.ipDrugChartDraft,
  };

  bool get isQueueCapture => switch (this) {
    StaffCaptureCallSite.nursingAssessmentDraftStorage ||
    StaffCaptureCallSite.opConsultationDraftStorage => true,
    _ => false,
  };
}

typedef StaffCaptureContextResolver =
    Future<StaffOfflineCaptureContext> Function(String appVersion);
typedef StaffPreparedCapture =
    Future<PersistedOfflineCommand> Function(OfflineCommandDraft draft);

@immutable
class StaffActionGatewayResult {
  const StaffActionGatewayResult._({
    required this.allowed,
    required this.reasonCode,
    this.persistedCommand,
    this.localDraftId,
  });

  const StaffActionGatewayResult.denied(String reasonCode)
    : this._(allowed: false, reasonCode: reasonCode);

  const StaffActionGatewayResult.queued(PersistedOfflineCommand command)
    : this._(allowed: true, reasonCode: 'queued', persistedCommand: command);

  const StaffActionGatewayResult.savedLocal(String draftId)
    : this._(allowed: true, reasonCode: 'saved_local', localDraftId: draftId);

  final bool allowed;
  final String reasonCode;
  final PersistedOfflineCommand? persistedCommand;
  final String? localDraftId;
}

class StaffClinicalActionGateway {
  StaffClinicalActionGateway({
    StaffActionPolicyRepository? repository,
    StaffCaptureContextResolver? contextResolver,
    StaffPreparedCapture? preparedCapture,
    ClinicalLocalDraftStore? localDraftStore,
    DateTime Function()? clock,
  }) : _repository = repository ?? StaffActionPolicyRepository.instance,
       _contextResolver =
           contextResolver ??
           ((appVersion) =>
               StaffOfflineCaptureContext.resolve(appVersion: appVersion)),
       _preparedCapture =
           preparedCapture ?? ConnectivitySyncService.instance.prepareCapture,
       _localDraftStore = localDraftStore ?? ClinicalLocalDraftStore(),
       _clock = clock ?? DateTime.now;

  static const currentAppVersion = '1.2.0+4';
  static final StaffClinicalActionGateway instance =
      StaffClinicalActionGateway();

  final StaffActionPolicyRepository _repository;
  final StaffCaptureContextResolver _contextResolver;
  final StaffPreparedCapture _preparedCapture;
  final ClinicalLocalDraftStore _localDraftStore;
  final DateTime Function() _clock;

  Future<StaffActionGatewayResult> capturePrivateDraft({
    required StaffCaptureCallSite callSite,
    required String patientReference,
    required Map<String, dynamic> payload,
    String? appointmentId,
    String? encounterId,
    String? admissionId,
    String? contextLabel,
  }) async {
    if (!callSite.isQueueCapture) {
      return const StaffActionGatewayResult.denied('call_site_not_queueable');
    }
    final context = await _resolveContext();
    if (context == null) {
      return const StaffActionGatewayResult.denied(
        'capture_context_unavailable',
      );
    }
    final decision = _repository.evaluate(
      context: context,
      actionId: callSite.actionId,
      stage: ClinicalContinuityActionGateStage.persist,
    );
    final policy = decision.policy;
    final rule = decision.rule;
    if (!decision.allowed || policy == null || rule == null) {
      return StaffActionGatewayResult.denied(decision.reasonCode);
    }
    final capturedAt = _clock().toUtc();
    final trustedAt = decision.trustedNow!.toUtc();
    final expiresAt = policy.effectiveUntil;
    final draft = OfflineCommandDraft(
      actionId: callSite.actionId,
      payload: payload,
      appVersion: context.appVersion,
      actionVersion: rule.actionVersion,
      actionChecksum: rule.actionChecksum,
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
      minimumAppVersion: decision.minimumAppVersion!,
      tenantId: context.tenantId,
      facilityId: context.facilityId,
      deviceId: context.deviceId,
      devicePosture: context.devicePosture,
      captureSessionId: context.captureSessionId,
      captureActorUuid: context.captureActorUuid,
      captureRole: context.captureRole,
      patientReference: patientReference,
      appointmentId: appointmentId,
      encounterId: encounterId,
      admissionId: admissionId,
      occurredAt: capturedAt,
      capturedAt: capturedAt,
      clockEvidence: OfflineClockEvidence(
        observedAt: capturedAt,
        serverTime: trustedAt,
        midpoint: trustedAt,
        skewMilliseconds: trustedAt.difference(capturedAt).inMilliseconds,
        uncertaintyMilliseconds: 0,
        toleranceMilliseconds: 30000,
        routeKind: 'signed_policy',
      ),
      cachedSources: {'patient_identity': trustedAt},
      expiresAt: expiresAt,
      orderingKey: [
        context.tenantId,
        context.facilityId,
        patientReference,
        appointmentId ?? encounterId ?? admissionId ?? 'unbound',
        callSite.actionId,
      ].join('\u0000'),
      contextLabel: contextLabel,
    );
    try {
      final persisted = await _preparedCapture(draft);
      return StaffActionGatewayResult.queued(persisted);
    } catch (_) {
      return const StaffActionGatewayResult.denied('prepared_capture_failed');
    }
  }

  Future<StaffActionGatewayResult> saveLocalDraft({
    required StaffCaptureCallSite callSite,
    required String patientReference,
    required Map<String, Object?> payload,
    String? appointmentId,
    String? encounterId,
    String? admissionId,
    String? existingDraftId,
  }) async {
    if (callSite.isQueueCapture) {
      return const StaffActionGatewayResult.denied('call_site_not_local_draft');
    }
    final context = await _resolveContext();
    if (context == null) {
      return const StaffActionGatewayResult.denied(
        'capture_context_unavailable',
      );
    }
    final decision = _repository.evaluate(
      context: context,
      actionId: callSite.actionId,
      stage: ClinicalContinuityActionGateStage.localDraft,
    );
    if (!decision.allowed) {
      return StaffActionGatewayResult.denied(decision.reasonCode);
    }
    final now = _clock().toUtc();
    final draftId = existingDraftId ?? IdempotencyKey.generate();
    final existing = existingDraftId == null
        ? null
        : await _localDraftStore.read(existingDraftId);
    await _localDraftStore.save(
      ClinicalLocalDraft(
        id: draftId,
        actionId: callSite.actionId,
        tenantId: context.tenantId,
        facilityId: context.facilityId,
        deviceId: context.deviceId,
        actorId: context.captureActorUuid,
        role: context.captureRole,
        patientReference: patientReference,
        encounterId: encounterId,
        appointmentId: appointmentId,
        admissionId: admissionId,
        payload: payload,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      ),
    );
    return StaffActionGatewayResult.savedLocal(draftId);
  }

  Future<ClinicalContinuityActionDecision> evaluateDrain(
    OfflineCommandEnvelope envelope,
  ) async {
    final context = StaffOfflineCaptureContext(
      tenantId: envelope.tenantId,
      facilityId: envelope.facilityId,
      deviceId: envelope.deviceId,
      devicePosture: envelope.devicePosture,
      captureSessionId: envelope.captureSessionId,
      captureActorUuid: envelope.captureActorUuid,
      captureRole: envelope.captureRole,
      appVersion: currentAppVersion,
    );
    return _repository.evaluatePreparedDrain(
      context: context,
      envelope: envelope,
    );
  }

  Future<PreparedDrainGateDecision> preparedDrainDecision(
    OfflineCommandEnvelope envelope,
  ) async {
    if (_repository.state != StaffActionPolicyState.verified) {
      return PreparedDrainGateDecision.pause(_repository.reasonCode);
    }
    final decision = await evaluateDrain(envelope);
    return decision.allowed
        ? const PreparedDrainGateDecision.allow()
        : PreparedDrainGateDecision.needsReview(decision.reasonCode);
  }

  Future<StaffOfflineCaptureContext?> _resolveContext() async {
    try {
      return await _contextResolver(currentAppVersion);
    } catch (_) {
      return null;
    }
  }
}
