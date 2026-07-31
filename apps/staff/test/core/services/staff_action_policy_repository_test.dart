import 'dart:async';

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

  test(
    'coalesces one audience refresh and preserves bounded retry metadata',
    () async {
      final source = _PendingSource();
      final repository = StaffActionPolicyRepository(source: source);
      addTearDown(repository.dispose);
      const audience = ClinicalContinuityAudience(
        tenantId: 'tenant-1',
        facilityId: '41',
      );

      final first = repository.refresh(audience: audience);
      final second = repository.refresh(audience: audience);
      source.completer.completeError(
        const StaffActionPolicySourceUnavailable(
          'policy_delivery_http_503',
          allowFallback: true,
          retryAfter: Duration(minutes: 5),
        ),
      );

      expect(await first, isFalse);
      expect(await second, isFalse);
      expect(source.calls, 1);
      expect(repository.retryableFailure, isTrue);
      expect(repository.retryAfter, const Duration(minutes: 5));
    },
  );

  test('invalidation discards a late source completion', () async {
    final source = _PendingSource();
    final repository = StaffActionPolicyRepository(source: source);
    addTearDown(repository.dispose);
    final refresh = repository.refresh(
      audience: const ClinicalContinuityAudience(
        tenantId: 'tenant-1',
        facilityId: '41',
      ),
    );

    repository.invalidate('application_backgrounded');
    source.completer.completeError(
      const StaffActionPolicySourceUnavailable(
        'policy_delivery_transport_unavailable',
        allowFallback: true,
      ),
    );

    expect(await refresh, isFalse);
    expect(repository.state, StaffActionPolicyState.unavailable);
    expect(repository.reasonCode, 'application_backgrounded');
  });

  test(
    'retries only transport status classes, never signed lifecycle denials',
    () {
      expect(
        StaffActionPolicyRepository.isRetryableReason(
          'policy_delivery_transport_unavailable',
        ),
        isTrue,
      );
      expect(
        StaffActionPolicyRepository.isRetryableReason(
          'policy_delivery_http_429',
        ),
        isTrue,
      );
      expect(
        StaffActionPolicyRepository.isRetryableReason(
          'CONTINUITY_POLICY_REVOKED',
        ),
        isFalse,
      );
      expect(
        StaffActionPolicyRepository.isRetryableReason(
          'CONTINUITY_POLICY_DELIVERY_INTEGRITY_FAILED',
        ),
        isFalse,
      );
    },
  );
}

class _PendingSource implements StaffActionPolicySource {
  final completer = Completer<StaffActionPolicySourcePayload>();
  int calls = 0;

  @override
  Future<StaffActionPolicySourcePayload> fetch({
    required ClinicalContinuityAudience audience,
  }) {
    calls += 1;
    return completer.future;
  }
}
