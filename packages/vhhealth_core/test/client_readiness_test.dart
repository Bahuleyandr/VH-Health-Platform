import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/client_readiness_config.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/models/client_readiness.dart';
import 'package:vhhealth_core/services/client_readiness_service.dart';

const tenantId = '00000000-0000-4000-8000-000000000001';
final serverNow = DateTime.utc(2026, 7, 30, 1, 2, 3);

Map<String, dynamic> readyPayload({
  String routeKind = 'public',
  String tenant = tenantId,
  DateTime? time,
}) {
  return {
    'readinessContractVersion': 1,
    'ready': true,
    'endpointId': 'vhhealth-api',
    'routeKind': routeKind,
    'tenantId': tenant,
    'database': 'ready',
    'policy': {'state': 'compatible', 'schemaVersion': 1},
    'serverTime': (time ?? serverNow).toIso8601String(),
  };
}

ApiResponse readyResponse(Map<String, dynamic> payload) {
  return ApiResponse(
    statusCode: 200,
    isSuccess: true,
    data: payload,
    raw: {'success': true, 'data': payload},
  );
}

ClientReadinessService serviceFor(
  ClientReadinessRequest request, {
  DateTime Function()? clock,
  Future<String?> Function()? authentication,
  ClientReadinessDelay? delay,
}) {
  return ClientReadinessService.forTesting(
    request: request,
    tenantId: () async => tenantId,
    staffId: () async => 'staff-1',
    authentication: authentication ?? () async => 'jwt-1',
    clock: clock ?? () => serverNow,
    delay: delay ?? (_) async {},
  );
}

void main() {
  group('ClientReadinessConfig', () {
    test('accepts the owner-provided 300 second build value', () {
      expect(ClientReadinessConfig.parseMaxClockSkewSeconds('300'), 300);
    });

    test('production fails closed on absent or invalid skew input', () {
      for (final value in ['', '0', '-1', '301', 'five-minutes']) {
        expect(
          () => ClientReadinessConfig.verifyOrThrow(
            production: true,
            rawValue: value,
          ),
          throwsStateError,
        );
      }
    });
  });

  group('ClientReadiness parser', () {
    test('accepts the exact ready contract', () {
      final readiness = ClientReadiness.fromJson(readyPayload());
      expect(readiness.isReadyForTenant(tenantId), isTrue);
      expect(readiness.routeKind, ClientReadinessRouteKind.public);
    });

    test('rejects unknown enums, extra fields, and unsupported policy', () {
      final unknownRoute = readyPayload()..['routeKind'] = 'caller-supplied';
      final extra = readyPayload()..['facility'] = 'secret';
      final unsupportedPolicy = readyPayload()
        ..['policy'] = {'state': 'compatible', 'schemaVersion': 2};

      expect(
        () => ClientReadiness.fromJson(unknownRoute),
        throwsFormatException,
      );
      expect(() => ClientReadiness.fromJson(extra), throwsFormatException);
      expect(
        ClientReadiness.fromJson(unsupportedPolicy).isReadyForTenant(tenantId),
        isFalse,
      );
    });

    test('accepts only the minimal stable not-ready shape', () {
      final response = ClientReadiness.fromJson({
        'readinessContractVersion': 1,
        'ready': false,
        'routeKind': 'internal',
        'state': 'policy_incompatible',
        'serverTime': serverNow.toIso8601String(),
      });
      expect(response.ready, isFalse);
      expect(response.state, ClientReadinessState.policyIncompatible);

      expect(
        () => ClientReadiness.fromJson({
          'readinessContractVersion': 1,
          'ready': false,
          'state': 'database_unavailable',
          'serverTime': serverNow.toIso8601String(),
          'databaseHost': 'db.internal',
        }),
        throwsFormatException,
      );
    });
  });

  group('ClientReadinessService', () {
    test('opens only after two matching successes', () async {
      var requests = 0;
      final delays = <Duration>[];
      final service = serviceFor(() async {
        requests++;
        return readyResponse(readyPayload(routeKind: 'internal'));
      }, delay: (duration) async => delays.add(duration));

      final result = await service.ensureReady();

      expect(requests, 2);
      expect(delays, const [Duration(seconds: 1)]);
      expect(result.ready, isTrue);
      expect(result.lifecycle, ContinuityLifecycleState.readyInternal);
    });

    test('fails closed for wrong tenant without a second probe', () async {
      var requests = 0;
      final service = serviceFor(() async {
        requests++;
        return readyResponse(
          readyPayload(tenant: '11111111-1111-4111-8111-111111111111'),
        );
      });

      expect((await service.ensureReady()).ready, isFalse);
      expect(requests, 1);
    });

    test('surfaces clock uncertainty beyond 300 seconds', () async {
      final service = serviceFor(
        () async => readyResponse(
          readyPayload(time: serverNow.add(const Duration(seconds: 301))),
        ),
      );

      final result = await service.ensureReady();

      expect(result.ready, isFalse);
      expect(result.lifecycle, ContinuityLifecycleState.clockUncertain);
      expect(result.clockSkew, greaterThan(const Duration(seconds: 300)));
    });

    test('Retry-After suppresses subsequent probes', () async {
      var requests = 0;
      final service = serviceFor(() async {
        requests++;
        return const ApiResponse(
          statusCode: 429,
          isSuccess: false,
          raw: {'retryAfterSeconds': 45},
        );
      });

      expect(
        (await service.ensureReady()).lifecycle,
        ContinuityLifecycleState.rateLimited,
      );
      expect(
        (await service.ensureReady()).lifecycle,
        ContinuityLifecycleState.rateLimited,
      );
      expect(requests, 1);
    });

    test('session change during the exchange fails closed', () async {
      var authReads = 0;
      final service = serviceFor(
        () async => readyResponse(readyPayload()),
        authentication: () async => ++authReads == 1 ? 'jwt-1' : 'jwt-2',
      );

      final result = await service.ensureReady();

      expect(result.ready, isFalse);
      expect(result.lifecycle, ContinuityLifecycleState.signedOut);
    });

    test(
      'an unauthorized readiness response preserves signed-out state',
      () async {
        final service = serviceFor(
          () async => const ApiResponse(
            statusCode: 401,
            isSuccess: false,
            raw: {'success': false},
          ),
        );

        final result = await service.ensureReady();

        expect(result.ready, isFalse);
        expect(result.lifecycle, ContinuityLifecycleState.signedOut);
      },
    );
  });
}
