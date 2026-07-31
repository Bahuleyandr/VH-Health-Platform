import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/offline_command_envelope.dart';
import 'package:vhhealth_staff/core/services/staff_action_policy_repository.dart';
import 'package:vhhealth_staff/core/services/staff_clinical_action_gateway.dart';
import 'package:vhhealth_staff/core/services/staff_offline_capture_context.dart';

void main() {
  late StaffActionPolicyRepository repository;
  late int preparedCount;
  late StaffClinicalActionGateway gateway;

  setUp(() {
    preparedCount = 0;
    repository = StaffActionPolicyRepository();
    gateway = StaffClinicalActionGateway(
      repository: repository,
      contextResolver: (_) async => _context,
      preparedCapture: (OfflineCommandDraft draft) async {
        preparedCount++;
        throw StateError('test must not persist');
      },
    );
  });

  tearDown(() => repository.dispose());

  test(
    'unavailable signed policy rejects before prepared persistence',
    () async {
      final result = await gateway.capturePrivateDraft(
        callSite: StaffCaptureCallSite.nursingAssessmentDraftStorage,
        patientReference: 'patient-1',
        payload: const {'note_type': 'nursing_assessment'},
      );

      expect(result.allowed, isFalse);
      expect(result.reasonCode, 'action_policy_unavailable');
      expect(preparedCount, 0);
    },
  );

  test('local-only call sites can never reach the queue callback', () async {
    for (final site in [
      StaffCaptureCallSite.opPrescriptionLocalDraft,
      StaffCaptureCallSite.ipDrugChartLocalDraft,
    ]) {
      final result = await gateway.capturePrivateDraft(
        callSite: site,
        patientReference: 'patient-1',
        payload: const {'draft': true},
      );
      expect(result.reasonCode, 'call_site_not_queueable');
    }
    expect(preparedCount, 0);
  });

  test('queue call sites can never enter the local-draft store', () async {
    for (final site in [
      StaffCaptureCallSite.nursingAssessmentDraftStorage,
      StaffCaptureCallSite.opConsultationDraftStorage,
    ]) {
      final result = await gateway.saveLocalDraft(
        callSite: site,
        patientReference: 'patient-1',
        payload: const {'draft': true},
      );
      expect(result.reasonCode, 'call_site_not_local_draft');
    }
  });
}

const _context = StaffOfflineCaptureContext(
  tenantId: 'tenant-1',
  facilityId: 41,
  deviceId: 'device-1',
  devicePosture: 'desktop',
  captureSessionId: 'session-1',
  captureActorUuid: 'actor-1',
  captureRole: 'NURSING_STAFF',
  appVersion: '1.2.0+4',
);
