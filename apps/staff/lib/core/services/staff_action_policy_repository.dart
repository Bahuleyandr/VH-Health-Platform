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

  static StaffActionPolicyRepository instance = StaffActionPolicyRepository();

  final StaffActionPolicySource _source;
  final ClinicalContinuityVerifier _verifier;
  final ClinicalContinuityCache _cache;
  final ClinicalContinuityActionGate _gate;

  StaffActionPolicyState _state = StaffActionPolicyState.unavailable;
  String _reasonCode = 'signed_policy_delivery_unavailable';
  VerifiedClinicalContinuityActionPolicy? _policy;
  Set<String> _capabilityGroups = const {};
  Stopwatch? _trustedElapsed;
  Duration? _retryAfter;
  int _generation = 0;
  Future<bool>? _inFlight;
  ClinicalContinuityAudience? _inFlightAudience;

  StaffActionPolicyState get state => _state;
  String get reasonCode => _reasonCode;
  VerifiedClinicalContinuityActionPolicy? get verifiedPolicy => _policy;
  Duration? get retryAfter => _retryAfter;
  bool get retryableFailure => isRetryableReason(_reasonCode);

  static bool isRetryableReason(String reasonCode) {
    if (reasonCode == 'policy_delivery_transport_unavailable' ||
        reasonCode == 'action_policy_refresh_failed') {
      return true;
    }
    final match = RegExp(
      r'^policy_delivery_http_(\d{3})$',
    ).firstMatch(reasonCode);
    final status = int.tryParse(match?.group(1) ?? '');
    return status == 408 ||
        status == 425 ||
        status == 429 ||
        (status != null && status >= 500 && status <= 599);
  }

  Future<bool> refresh({required ClinicalContinuityAudience audience}) async {
    final current = _inFlight;
    if (current != null && _sameAudience(_inFlightAudience, audience)) {
      return current;
    }
    if (current != null) invalidate('action_policy_context_changed');
    final generation = ++_generation;
    _inFlightAudience = audience;
    _retryAfter = null;
    _setState(StaffActionPolicyState.refreshing, 'action_policy_refreshing');
    late final Future<bool> operation;
    operation = _refresh(generation: generation, audience: audience);
    _inFlight = operation;
    try {
      return await operation;
    } finally {
      if (identical(_inFlight, operation)) {
        _inFlight = null;
        _inFlightAudience = null;
      }
    }
  }

  Future<bool> _refresh({
    required int generation,
    required ClinicalContinuityAudience audience,
  }) async {
    try {
      final payload = await _source.fetch(audience: audience);
      if (!_isCurrent(generation, audience)) return false;
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
      if (!_isCurrent(generation, audience)) return false;
      final verification = await _verifier.verifyActionPolicy(
        envelopeBytes: payload.policyEnvelopeBytes,
        policyId: payload.policyId,
        expectedAudience: audience,
        clock: payload.clock,
        persistedFloors: floors,
      );
      if (!_isCurrent(generation, audience)) return false;
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
        packCompositionVersion: policy.packCompositionVersion,
        trustedNow: policy.trustedAt,
      );
      if (!_isCurrent(generation, audience)) return false;
      if (!advanced) {
        return _deny('action_policy_floor_rejected');
      }
      _policy = policy;
      _capabilityGroups = Set.unmodifiable(payload.capabilityGroups);
      _trustedElapsed = Stopwatch()..start();
      _setState(StaffActionPolicyState.verified, 'verified');
      return true;
    } catch (error) {
      if (!_isCurrent(generation, audience)) return false;
      final reason = error is StaffActionPolicySourceUnavailable
          ? error.reasonCode
          : 'action_policy_refresh_failed';
      return _deny(
        reason,
        retryAfter: error is StaffActionPolicySourceUnavailable
            ? error.retryAfter
            : null,
      );
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
    _invalidate(reasonCode);
  }

  void _invalidate(String reasonCode, {Duration? retryAfter}) {
    _generation += 1;
    _policy = null;
    _capabilityGroups = const {};
    _retryAfter = retryAfter;
    _trustedElapsed
      ?..stop()
      ..reset();
    _trustedElapsed = null;
    _setState(StaffActionPolicyState.unavailable, reasonCode);
  }

  bool _deny(String reasonCode, {Duration? retryAfter}) {
    _invalidate(reasonCode, retryAfter: retryAfter);
    return false;
  }

  bool _isCurrent(int generation, ClinicalContinuityAudience audience) =>
      generation == _generation && _sameAudience(_inFlightAudience, audience);

  static bool _sameAudience(
    ClinicalContinuityAudience? left,
    ClinicalContinuityAudience right,
  ) => left?.tenantId == right.tenantId && left?.facilityId == right.facilityId;

  void _setState(StaffActionPolicyState value, String reasonCode) {
    _state = value;
    _reasonCode = reasonCode;
    notifyListeners();
  }

  @override
  void dispose() {
    _generation += 1;
    _trustedElapsed?.stop();
    unawaited(_cache.close());
    super.dispose();
  }
}
