import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/models/clinical_continuity.dart';
import 'package:vhhealth_core/services/clinical_continuity_facility_context.dart';
import 'package:vhhealth_core/services/clinical_continuity_policy_delivery.dart';

typedef StaffCapabilityGroupsProvider = Future<Set<String>> Function();
typedef StaffVerifiedContinuitySetProvider =
    VerifiedClinicalContinuitySet? Function();
typedef StaffTrustedClockProvider =
    ClinicalContinuityClockAssessment Function();

@immutable
class StaffActionPolicySourcePayload {
  const StaffActionPolicySourcePayload({
    required this.policyId,
    required this.policyEnvelopeBytes,
    required this.provenance,
    required this.clock,
    required this.capabilityGroups,
  });

  /// Authenticated immutable row identity supplied by the approved source.
  /// The C4.2 signing payload deliberately does not contain its database ID.
  final String policyId;
  final Uint8List policyEnvelopeBytes;
  final ClinicalContinuitySourceProvenance provenance;
  final ClinicalContinuityClockAssessment clock;
  final Set<String> capabilityGroups;
}

abstract interface class StaffActionPolicySource {
  Future<StaffActionPolicySourcePayload> fetch({
    required ClinicalContinuityAudience audience,
  });
}

class BackendStaffActionPolicySource implements StaffActionPolicySource {
  BackendStaffActionPolicySource({
    ClinicalContinuityPolicyDeliveryClient? deliveryClient,
    ClinicalContinuityFacilityContextClient? facilityContextClient,
    StaffCapabilityGroupsProvider? capabilityGroupsProvider,
  }) : _deliveryClient =
           deliveryClient ?? ClinicalContinuityPolicyDeliveryClient(),
       _facilityContextClient =
           facilityContextClient ??
           const ClinicalContinuityFacilityContextClient(),
       _capabilityGroupsProvider = capabilityGroupsProvider ?? _noCapabilities;

  final ClinicalContinuityPolicyDeliveryClient _deliveryClient;
  final ClinicalContinuityFacilityContextClient _facilityContextClient;
  final StaffCapabilityGroupsProvider _capabilityGroupsProvider;

  static Future<Set<String>> _noCapabilities() async => const {};

  @override
  Future<StaffActionPolicySourcePayload> fetch({
    required ClinicalContinuityAudience audience,
  }) async {
    final context = await _facilityContextClient.current();
    if (context == null ||
        context.tenantId != audience.tenantId ||
        context.facilityId != audience.facilityId) {
      throw const StaffActionPolicySourceUnavailable(
        'facility_context_unavailable',
      );
    }
    try {
      final delivery = await _deliveryClient.fetch(
        facilityId: audience.facilityId,
        facilityContextHeader: context.headerValue,
      );
      return StaffActionPolicySourcePayload(
        policyId: delivery.policyId,
        policyEnvelopeBytes: delivery.envelopeBytes,
        provenance: delivery.provenance,
        clock: delivery.clock,
        capabilityGroups: Set.unmodifiable(await _capabilityGroupsProvider()),
      );
    } on ClinicalContinuityPolicyDeliveryException catch (error) {
      throw StaffActionPolicySourceUnavailable(
        error.reasonCode,
        allowFallback: _isTransientDeliveryFailure(error),
        retryAfter: error.retryAfter,
      );
    } catch (_) {
      throw const StaffActionPolicySourceUnavailable(
        'policy_delivery_transport_unavailable',
        allowFallback: true,
      );
    }
  }
}

class VerifiedPackStaffActionPolicySource implements StaffActionPolicySource {
  const VerifiedPackStaffActionPolicySource({
    required StaffVerifiedContinuitySetProvider verifiedSetProvider,
    required StaffTrustedClockProvider trustedClockProvider,
    StaffCapabilityGroupsProvider? capabilityGroupsProvider,
  }) : _verifiedSetProvider = verifiedSetProvider,
       _trustedClockProvider = trustedClockProvider,
       _capabilityGroupsProvider = capabilityGroupsProvider;

  final StaffVerifiedContinuitySetProvider _verifiedSetProvider;
  final StaffTrustedClockProvider _trustedClockProvider;
  final StaffCapabilityGroupsProvider? _capabilityGroupsProvider;

  @override
  Future<StaffActionPolicySourcePayload> fetch({
    required ClinicalContinuityAudience audience,
  }) async {
    final set = _verifiedSetProvider();
    final bytes = set?.policyEnvelopeBytes;
    final clock = _trustedClockProvider();
    if (set == null ||
        set.audience.tenantId != audience.tenantId ||
        set.audience.facilityId != audience.facilityId ||
        set.packCompositionVersion != '2' ||
        bytes == null ||
        bytes.isEmpty ||
        !clock.trusted ||
        clock.trustedNow == null) {
      throw const StaffActionPolicySourceUnavailable(
        'verified_pack_policy_unavailable',
      );
    }
    return StaffActionPolicySourcePayload(
      policyId: set.policyId,
      policyEnvelopeBytes: Uint8List.fromList(bytes),
      provenance: set.provenance,
      clock: clock,
      capabilityGroups: Set.unmodifiable(
        await (_capabilityGroupsProvider?.call() ?? Future.value(const {})),
      ),
    );
  }
}

class CompositeStaffActionPolicySource implements StaffActionPolicySource {
  const CompositeStaffActionPolicySource(this.sources);

  final List<StaffActionPolicySource> sources;

  @override
  Future<StaffActionPolicySourcePayload> fetch({
    required ClinicalContinuityAudience audience,
  }) async {
    StaffActionPolicySourceUnavailable? transientFailure;
    StaffActionPolicySourceUnavailable? lastFailure;
    for (final source in sources) {
      try {
        return await source.fetch(audience: audience);
      } on StaffActionPolicySourceUnavailable catch (error) {
        if (!error.allowFallback) rethrow;
        transientFailure ??= error;
        lastFailure = error;
      }
    }
    throw transientFailure ??
        lastFailure ??
        const StaffActionPolicySourceUnavailable(
          'signed_policy_delivery_unavailable',
        );
  }
}

class UnavailableStaffActionPolicySource implements StaffActionPolicySource {
  const UnavailableStaffActionPolicySource();

  @override
  Future<StaffActionPolicySourcePayload> fetch({
    required ClinicalContinuityAudience audience,
  }) {
    throw const StaffActionPolicySourceUnavailable(
      'signed_policy_delivery_unavailable',
    );
  }
}

class StaffActionPolicySourceUnavailable implements Exception {
  const StaffActionPolicySourceUnavailable(
    this.reasonCode, {
    this.allowFallback = false,
    this.retryAfter,
  });

  final String reasonCode;
  final bool allowFallback;
  final Duration? retryAfter;

  @override
  String toString() => 'StaffActionPolicySourceUnavailable($reasonCode)';
}

bool _isTransientDeliveryFailure(
  ClinicalContinuityPolicyDeliveryException error,
) {
  if (error.reasonCode == 'CONTINUITY_POLICY_DELIVERY_INTEGRITY_FAILED') {
    return false;
  }
  final status = error.statusCode;
  return status == 408 ||
      status == 425 ||
      status == 429 ||
      (status != null && status >= 500 && status <= 599);
}

abstract final class StaffActionPolicyDeliveryPrerequisites {
  static const approvedSourceInventory = 'approved_source_inventory_required';
  static const exactPreverifiedBytes =
      'exact_preverified_signed_bytes_required';
  static const authenticatedProvenance =
      'authenticated_source_provenance_required';
  static const coordinatorTracked = 'program_level_activation_prerequisite';

  static const values = <String>{
    approvedSourceInventory,
    exactPreverifiedBytes,
    authenticatedProvenance,
    coordinatorTracked,
  };
}
