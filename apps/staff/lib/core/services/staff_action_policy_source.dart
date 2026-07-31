import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/models/clinical_continuity.dart';

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
  const StaffActionPolicySourceUnavailable(this.reasonCode);

  final String reasonCode;

  @override
  String toString() => 'StaffActionPolicySourceUnavailable($reasonCode)';
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
