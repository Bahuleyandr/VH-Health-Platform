import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/core/outage/patient_readiness.dart';
import 'package:vhhealth_core/models/api_response.dart';

/// Regression coverage for the PATIENT-only operational-readiness route.
void main() {
  late PatientOutageController controller;
  final now = DateTime.utc(2026, 8, 2, 12);

  tearDown(() {
    controller.dispose();
  });

  for (final tenant in const {
    'default tenant': '00000000-0000-4000-8000-000000000001',
    'non-default tenant': '8f36e6e8-73e9-489b-94ea-e94d3d953878',
  }.entries) {
    test(
      '${tenant.key} readiness opens the client without policy state',
      () async {
        var requests = 0;
        controller = PatientOutageController.forTesting(
          request: () async {
            requests++;
            return _response(_patientReady(now, tenant.value));
          },
          authentication: () async => 'patient-session',
          tenantId: () async => tenant.value,
          maxClockSkew: const Duration(seconds: 5),
          clock: () => now,
          delay: (_) async {},
        );

        expect(await controller.probeNow(), isTrue);
        expect(controller.status, PatientOutageStatus.available);
        expect(controller.isOutage, isFalse);
        expect(controller.blocksHospitalMutations, isFalse);
        expect(controller.reason, PatientOutageReason.none);
        expect(requests, 2);
      },
    );
  }

  test('a forbidden readiness probe is reported as an authorization refusal, '
      'not a malformed body', () async {
    controller = PatientOutageController.forTesting(
      request: () async => const ApiResponse(
        statusCode: 403,
        isSuccess: false,
        raw: {'success': false, 'message': 'Access denied: insufficient role'},
      ),
      authentication: () async => 'patient-session',
      tenantId: () async => '00000000-0000-4000-8000-000000000001',
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
      tenantId: () async => '00000000-0000-4000-8000-000000000001',
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

Map<String, dynamic> _patientReady(DateTime now, String tenant) => {
  'readinessContractVersion': PatientReadinessConfig.contractVersion,
  'readinessPurpose': PatientReadinessConfig.purpose,
  'ready': true,
  'endpointId': PatientReadinessConfig.endpointId,
  'routeKind': 'public',
  'tenantId': tenant,
  'database': 'ready',
  'serverTime': now.toIso8601String(),
};
