import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/outage/patient_readiness.dart';

void main() {
  final now = DateTime.utc(2026, 8, 2, 12).toIso8601String();

  test('pins the PATIENT-only operational readiness route', () {
    expect(PatientReadinessConfig.path, '/health/patient-readiness');
    expect(PatientReadinessConfig.purpose, 'patient_outage');
  });

  test('accepts the exact ready shape for either route kind', () {
    for (final routeKind in ['public', 'internal']) {
      final readiness = PatientReadiness.fromJson(
        _ready(now, routeKind: routeKind),
      );

      expect(readiness.ready, isTrue);
      expect(readiness.isReadyForTenant('tenant-a'), isTrue);
    }
  });

  test('accepts exact failure shapes with optional route kind', () {
    for (final state in ['endpoint_unverified', 'database_unavailable']) {
      final withoutRoute = PatientReadiness.fromJson(_notReady(now, state));
      final withRoute = PatientReadiness.fromJson({
        ..._notReady(now, state),
        'routeKind': 'public',
      });

      expect(withoutRoute.ready, isFalse);
      expect(withoutRoute.routeKind, isNull);
      expect(withRoute.routeKind, PatientReadinessRouteKind.public);
    }
  });

  test('rejects policy and every other extra field', () {
    expect(
      () => PatientReadiness.fromJson({..._ready(now), 'policy': {}}),
      throwsFormatException,
    );
    expect(
      () => PatientReadiness.fromJson({
        ..._notReady(now, 'endpoint_unverified'),
        'detail': 'internal',
      }),
      throwsFormatException,
    );
  });

  test('rejects wrong purpose, version, endpoint, database, and tenant', () {
    for (final malformed in [
      {..._ready(now), 'readinessPurpose': 'staff_continuity'},
      {..._ready(now), 'readinessContractVersion': 2},
      {..._ready(now), 'endpointId': 'another-api'},
      {..._ready(now), 'database': 'unknown'},
      {..._ready(now), 'tenantId': ''},
    ]) {
      expect(() => PatientReadiness.fromJson(malformed), throwsFormatException);
    }
  });

  test('rejects incomplete, unknown-state, and non-UTC responses', () {
    final missingDatabase = _ready(now)..remove('database');
    expect(
      () => PatientReadiness.fromJson(missingDatabase),
      throwsFormatException,
    );
    expect(
      () => PatientReadiness.fromJson(_notReady(now, 'policy_incompatible')),
      throwsFormatException,
    );
    expect(
      () => PatientReadiness.fromJson(_ready('2026-08-02T12:00:00')),
      throwsFormatException,
    );
  });
}

Map<String, dynamic> _ready(String serverTime, {String routeKind = 'public'}) =>
    {
      'readinessContractVersion': PatientReadinessConfig.contractVersion,
      'readinessPurpose': PatientReadinessConfig.purpose,
      'ready': true,
      'endpointId': PatientReadinessConfig.endpointId,
      'routeKind': routeKind,
      'tenantId': 'tenant-a',
      'database': 'ready',
      'serverTime': serverTime,
    };

Map<String, dynamic> _notReady(String serverTime, String state) => {
  'readinessContractVersion': PatientReadinessConfig.contractVersion,
  'readinessPurpose': PatientReadinessConfig.purpose,
  'ready': false,
  'state': state,
  'serverTime': serverTime,
};
