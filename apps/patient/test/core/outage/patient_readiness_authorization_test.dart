import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth_core/config/client_readiness_config.dart';
import 'package:vhhealth_core/models/api_response.dart';

/// Regression coverage for the C-D12 patient readiness probe's authorization
/// posture.
///
/// The patient app probes the SAME C2.2 contract the Staff app uses
/// (`GET /api/v1/health/client-readiness`). That route was gated on
/// `rbacConfig.staffRoutes`, which excludes PATIENT, so every patient probe
/// answered 403. 403 had no branch in `_probeOnce`, so it fell through to the
/// body parse, found no `details.readiness`, and closed the client as
/// `malformedReadiness`. Because only two matching readiness *successes*
/// reopen the client (C-D12 section 5.3), that outage was permanent, and the
/// default-deny mutation gate then refused every hospital-facing write —
/// bookings, cancellations, medical requests, and SOS.
///
/// The backend fix authorizes PATIENT on the read-only readiness projection
/// (`rbacConfig.clientReadinessRoutes`), pinned by
/// `apps/backend/src/tests/client-readiness.deep.test.js`. These tests pin the
/// client half of that contract.
void main() {
  late PatientOutageController controller;
  final now = DateTime.utc(2026, 8, 2, 12);
  const tenant = '00000000-0000-4000-8000-000000000001';

  tearDown(() {
    controller.dispose();
  });

  test('the readiness body a PATIENT now receives opens the client and never '
      'enters outage', () async {
    var requests = 0;
    controller = PatientOutageController.forTesting(
      request: () async {
        requests++;
        return _response(_patientReady(now, tenant));
      },
      authentication: () async => 'patient-session',
      tenantId: () async => tenant,
      maxClockSkew: const Duration(seconds: 5),
      clock: () => now,
      delay: (_) async {},
    );

    expect(await controller.probeNow(), isTrue);
    expect(controller.status, PatientOutageStatus.available);
    expect(controller.isOutage, isFalse);
    // The default-deny mutation gate must be open, or SOS stays refused.
    expect(controller.blocksHospitalMutations, isFalse);
    expect(controller.reason, PatientOutageReason.none);
    expect(requests, 2);
  });

  test('a forbidden readiness probe is reported as an authorization refusal, '
      'not a malformed body', () async {
    controller = PatientOutageController.forTesting(
      request: () async => const ApiResponse(
        statusCode: 403,
        isSuccess: false,
        raw: {'success': false, 'message': 'Access denied: insufficient role'},
      ),
      authentication: () async => 'patient-session',
      tenantId: () async => tenant,
      maxClockSkew: const Duration(seconds: 5),
      clock: () => now,
      delay: (_) async {},
    );

    expect(await controller.probeNow(), isFalse);
    // C-D12 section 5.2 keeps an invalid readiness answer fail-closed, so
    // this stays an outage. What must never happen again is the silent
    // mislabelling that disguised a role gate as a parser fault.
    expect(controller.status, PatientOutageStatus.outage);
    expect(controller.reason, PatientOutageReason.probeForbidden);
    expect(controller.reason, isNot(PatientOutageReason.malformedReadiness));
  });

  test('a 403 is not mistaken for a signed-out session', () async {
    controller = PatientOutageController.forTesting(
      request: () async => const ApiResponse(
        statusCode: 403,
        isSuccess: false,
        raw: {'success': false},
      ),
      authentication: () async => 'patient-session',
      tenantId: () async => tenant,
      maxClockSkew: const Duration(seconds: 5),
      clock: () => now,
      delay: (_) async {},
    );

    expect(await controller.probeNow(), isFalse);
    expect(controller.status, isNot(PatientOutageStatus.signedOut));
  });
}

ApiResponse _response(Map<String, dynamic> data) => ApiResponse(
  statusCode: 200,
  isSuccess: true,
  data: data,
  raw: {'data': data},
);

/// The exact 200 projection the backend serves a PATIENT bearer, mirroring
/// `readyPayload` in `apps/backend/src/services/health/clientReadinessService.js`
/// and the key set pinned by the backend deep test.
Map<String, dynamic> _patientReady(DateTime now, String tenant) => {
  'readinessContractVersion': ClientReadinessConfig.contractVersion,
  'ready': true,
  'endpointId': ClientReadinessConfig.endpointId,
  'routeKind': 'public',
  'tenantId': tenant,
  'database': 'ready',
  'policy': {
    'state': 'compatible',
    'schemaVersion': ClientReadinessConfig.policySchemaVersion,
  },
  'serverTime': now.toIso8601String(),
};
