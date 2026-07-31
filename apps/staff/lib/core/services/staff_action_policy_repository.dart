import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/models/clinical_continuity.dart';
import 'package:vhhealth_core/models/clinical_continuity_action_policy.dart';
import 'package:vhhealth_core/models/offline_command_envelope.dart';
import 'package:vhhealth_core/services/clinical_continuity_action_gate.dart';
import 'package:vhhealth_core/services/clinical_continuity_cache.dart';
import 'package:vhhealth_core/services/clinical_continuity_verifier.dart';

import 'staff_action_policy_source.dart';
import 'staff_offline_capture_context.dart';

enum StaffActionPolicyState { unavailable, refreshing, verified }

class StaffActionPolicyRepository extends ChangeNotifier {
  StaffActionPolicyRepository({
    StaffActionPolicySource source = const UnavailableStaffActionPolicySource(),
    ClinicalContinuityVerifier? verifier,
    ClinicalContinuityCache? cache,
    ClinicalContinuityActionGate gate = const ClinicalContinuityActionGate(),
  }) : _source = source,
       _verifier = verifier ?? ClinicalContinuityVerifier(),
       _cache = cache ?? ClinicalContinuityCache(),
       _gate = gate;

  static final StaffActionPolicyRepository instance =
      StaffActionPolicyRepository();

  final StaffActionPolicySource _source;
  final ClinicalContinuityVerifier _verifier;
  final ClinicalContinuityCache _cache;
  final ClinicalContinuityActionGate _gate;

  StaffActionPolicyState _state = StaffActionPolicyState.unavailable;
  String _reasonCode = 'signed_policy_delivery_unavailable';
  VerifiedClinicalContinuityActionPolicy? _policy;
  Set<String> _capabilityGroups = const {};
  Stopwatch? _trustedElapsed;

  StaffActionPolicyState get state => _state;
  String get reasonCode => _reasonCode;
  VerifiedClinicalContinuityActionPolicy? get verifiedPolicy => _policy;

  Future<bool> refresh({required ClinicalContinuityAudience audience}) async {
    _setState(StaffActionPolicyState.refreshing, 'action_policy_refreshing');
    try {
      final payload = await _source.fetch(audience: audience);
      if (payload.policyId.trim().isEmpty ||
          payload.policyEnvelopeBytes.isEmpty ||
          payload.provenance.sourceRevision.trim().isEmpty ||
          payload.provenance.sourceWatermark.trim().isEmpty ||
          !payload.clock.trusted ||
          payload.clock.trustedNow == null) {
        return _deny('action_policy_source_invalid');
      }
      final floors = await _cache.readFloors(
        tenantId: audience.tenantId,
        facilityId: audience.facilityId,
      );
      final verification = await _verifier.verifyActionPolicy(
        envelopeBytes: payload.policyEnvelopeBytes,
        policyId: payload.policyId,
        expectedAudience: audience,
        clock: payload.clock,
        persistedFloors: floors,
      );
      final policy = verification.verifiedPolicy;
      if (!verification.ok || policy == null) {
        return _deny(
          verification.reason ?? 'action_policy_verification_failed',
        );
      }
      final advanced = await _cache.advanceActionPolicyFloors(
        tenantId: audience.tenantId,
        facilityId: audience.facilityId,
        policyVersion: policy.policyVersion,
        registryVersion: policy.registryVersion,
        registryChecksum: policy.registryChecksum,
        revocationEpoch: policy.policyRevocationEpoch,
        trustedNow: policy.trustedAt,
      );
      if (!advanced) {
        return _deny('action_policy_floor_rejected');
      }
      _policy = policy;
      _capabilityGroups = Set.unmodifiable(payload.capabilityGroups);
      _trustedElapsed = Stopwatch()..start();
      _setState(StaffActionPolicyState.verified, 'verified');
      return true;
    } catch (error) {
      final reason = error is StaffActionPolicySourceUnavailable
          ? error.reasonCode
          : 'action_policy_refresh_failed';
      return _deny(reason);
    }
  }

  ClinicalContinuityActionDecision evaluate({
    required StaffOfflineCaptureContext context,
    required String actionId,
    required ClinicalContinuityActionGateStage stage,
  }) {
    final policy = _currentPolicy;
    return _gate.evaluate(
      policy: policy,
      actionId: actionId,
      stage: stage,
      context: _actionContext(context, policy),
    );
  }

  ClinicalContinuityActionDecision evaluatePreparedDrain({
    required StaffOfflineCaptureContext context,
    required OfflineCommandEnvelope envelope,
  }) {
    final policy = _currentPolicy;
    return _gate.evaluatePreparedDrain(
      policy: policy,
      envelope: envelope,
      context: _actionContext(context, policy),
    );
  }

  VerifiedClinicalContinuityActionPolicy? get _currentPolicy =>
      _state == StaffActionPolicyState.verified ? _policy : null;

  ClinicalContinuityActionContext _actionContext(
    StaffOfflineCaptureContext context,
    VerifiedClinicalContinuityActionPolicy? policy,
  ) {
    final elapsed = _trustedElapsed?.elapsed ?? Duration.zero;
    final trustedNow = policy?.trustedAt.add(elapsed) ?? DateTime.utc(1970);
    return ClinicalContinuityActionContext(
      tenantId: context.tenantId,
      facilityId: context.facilityId,
      devicePosture: context.devicePosture,
      role: context.captureRole,
      capabilityGroups: _capabilityGroups,
      appVersion: context.appVersion,
      trustedNow: trustedNow,
    );
  }

  void invalidate([String reasonCode = 'action_policy_invalidated']) {
    _policy = null;
    _capabilityGroups = const {};
    _trustedElapsed
      ?..stop()
      ..reset();
    _trustedElapsed = null;
    _setState(StaffActionPolicyState.unavailable, reasonCode);
  }

  bool _deny(String reasonCode) {
    invalidate(reasonCode);
    return false;
  }

  void _setState(StaffActionPolicyState value, String reasonCode) {
    _state = value;
    _reasonCode = reasonCode;
    notifyListeners();
  }

  @override
  void dispose() {
    _trustedElapsed?.stop();
    unawaited(_cache.close());
    super.dispose();
  }
}
