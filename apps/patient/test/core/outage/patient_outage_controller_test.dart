import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth_core/config/client_readiness_config.dart';
import 'package:vhhealth_core/models/api_response.dart';

void main() {
  late PatientOutageController controller;
  final now = DateTime.utc(2026, 8, 2, 12);

  tearDown(() {
    controller.dispose();
  });

  test(
    'opens only after two matching strict patient readiness successes',
    () async {
      var requests = 0;
      var delays = 0;
      controller = PatientOutageController.forTesting(
        request: () async {
          requests++;
          return _response(_ready(now));
        },
        authentication: () async => 'patient-session',
        tenantId: () async => 'tenant-a',
        maxClockSkew: const Duration(seconds: 5),
        clock: () => now,
        delay: (_) async => delays++,
      );

      expect(await controller.probeNow(), isTrue);
      expect(controller.status, PatientOutageStatus.available);
      expect(requests, 2);
      expect(delays, 1);
    },
  );

  test(
    'closes on a typed not-ready second response and does not flap open',
    () async {
      var requests = 0;
      controller = PatientOutageController.forTesting(
        request: () async {
          requests++;
          return _response(
            requests == 1
                ? _ready(now)
                : _notReady(now, 'database_unavailable'),
          );
        },
        authentication: () async => 'patient-session',
        tenantId: () async => 'tenant-a',
        maxClockSkew: const Duration(seconds: 5),
        clock: () => now,
        delay: (_) async {},
      );

      expect(await controller.probeNow(), isFalse);
      expect(controller.status, PatientOutageStatus.outage);
      expect(controller.reason, PatientOutageReason.databaseUnavailable);
      expect(requests, 2);
    },
  );

  test('rejects a session identity change between recovery probes', () async {
    var authenticationReads = 0;
    controller = PatientOutageController.forTesting(
      request: () async => _response(_ready(now)),
      authentication: () async {
        authenticationReads++;
        return authenticationReads < 4 ? 'patient-session' : 'new-session';
      },
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
      clock: () => now,
      delay: (_) async {},
    );

    expect(await controller.probeNow(), isFalse);
    expect(controller.status, PatientOutageStatus.signedOut);
  });

  test('airplane-mode signal closes immediately', () {
    controller = PatientOutageController.forTesting(
      request: () async => _response(_ready(now)),
      authentication: () async => 'patient-session',
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
    );

    controller.markAvailableForTesting();
    controller.handleConnectivityChanged(false);

    expect(controller.status, PatientOutageStatus.outage);
    expect(controller.reason, PatientOutageReason.transportUnavailable);
  });

  test('network request failure closes as transport unavailable', () async {
    controller = PatientOutageController.forTesting(
      request: () => throw TimeoutException('readiness timed out'),
      authentication: () async => 'patient-session',
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
      clock: () => now,
    );

    expect(await controller.probeNow(), isFalse);
    expect(controller.status, PatientOutageStatus.outage);
    expect(controller.reason, PatientOutageReason.transportUnavailable);
  });

  test('typed backend 503 closes with its readiness reason', () async {
    controller = PatientOutageController.forTesting(
      request: () async => _response(_ready(now)),
      authentication: () async => 'patient-session',
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
      clock: () => now,
    );
    controller.markAvailableForTesting();

    await controller.observeResponse(
      ApiResponse(
        statusCode: 503,
        isSuccess: false,
        raw: {
          'details': {'readiness': _notReady(now, 'database_unavailable')},
        },
      ),
    );

    expect(controller.status, PatientOutageStatus.outage);
    expect(controller.reason, PatientOutageReason.databaseUnavailable);
  });

  test('rate limiting closes and records a distinct outage reason', () async {
    controller = PatientOutageController.forTesting(
      request: () async => const ApiResponse(
        statusCode: 429,
        isSuccess: false,
        raw: {'retryAfterSeconds': 30},
      ),
      authentication: () async => 'patient-session',
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
      clock: () => now,
    );

    expect(await controller.probeNow(), isFalse);
    expect(controller.status, PatientOutageStatus.outage);
    expect(controller.reason, PatientOutageReason.rateLimited);
  });
}

ApiResponse _response(Map<String, dynamic> data) => ApiResponse(
  statusCode: 200,
  isSuccess: true,
  data: data,
  raw: {'data': data},
);

Map<String, dynamic> _ready(DateTime now) => {
  'readinessContractVersion': ClientReadinessConfig.contractVersion,
  'ready': true,
  'endpointId': ClientReadinessConfig.endpointId,
  'routeKind': 'public',
  'tenantId': 'tenant-a',
  'database': 'ready',
  'policy': {
    'state': 'compatible',
    'schemaVersion': ClientReadinessConfig.policySchemaVersion,
  },
  'serverTime': now.toIso8601String(),
};

Map<String, dynamic> _notReady(DateTime now, String state) => {
  'readinessContractVersion': ClientReadinessConfig.contractVersion,
  'ready': false,
  'state': state,
  'serverTime': now.toIso8601String(),
};
