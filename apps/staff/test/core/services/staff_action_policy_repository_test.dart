import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/clinical_continuity.dart';
import 'package:vhhealth_core/services/clinical_continuity_action_gate.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';
import 'package:vhhealth_staff/core/services/staff_action_policy_repository.dart';
import 'package:vhhealth_staff/core/services/staff_action_policy_source.dart';
import 'package:vhhealth_staff/core/services/staff_offline_capture_context.dart';

void main() {
  test(
    'production source remains unavailable and enforcement fails closed',
    () async {
      final repository = StaffActionPolicyRepository();
      addTearDown(repository.dispose);

      final refreshed = await repository.refresh(
        audience: const ClinicalContinuityAudience(
          tenantId: 'tenant-1',
          facilityId: '41',
        ),
      );

      expect(refreshed, isFalse);
      expect(repository.state, StaffActionPolicyState.unavailable);
      expect(repository.reasonCode, 'signed_policy_delivery_unavailable');
      final decision = repository.evaluate(
        context: const StaffOfflineCaptureContext(
          tenantId: 'tenant-1',
          facilityId: 41,
          deviceId: 'device-1',
          devicePosture: 'desktop',
          captureSessionId: 'session-1',
          captureActorUuid: 'actor-1',
          captureRole: 'NURSING_STAFF',
          appVersion: '1.2.0+4',
        ),
        actionId: OfflineActionIds.nursingNoteDraftStore,
        stage: ClinicalContinuityActionGateStage.persist,
      );
      expect(decision.allowed, isFalse);
      expect(decision.reasonCode, 'action_policy_unavailable');
    },
  );

  test('delivery prerequisites stay explicit program inputs', () {
    expect(StaffActionPolicyDeliveryPrerequisites.values, {
      'approved_source_inventory_required',
      'exact_preverified_signed_bytes_required',
      'authenticated_source_provenance_required',
      'program_level_activation_prerequisite',
    });
  });
}
