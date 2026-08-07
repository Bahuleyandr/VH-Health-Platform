enum PatientReadinessRouteKind { public, internal }

enum PatientReadinessState { endpointUnverified, databaseUnavailable }

class PatientReadinessConfig {
  PatientReadinessConfig._();

  static const String path = '/health/patient-readiness';
  static const String endpointId = 'vhhealth-api';
  static const String purpose = 'patient_outage';
  static const int contractVersion = 1;
}

/// Strict, low-information response from the authenticated Patient readiness
/// route.
class PatientReadiness {
  static const Set<String> _allowedKeys = {
    'readinessContractVersion',
    'readinessPurpose',
    'ready',
    'state',
    'endpointId',
    'routeKind',
    'tenantId',
    'database',
    'serverTime',
  };

  const PatientReadiness({
    required this.ready,
    required this.state,
    required this.routeKind,
    required this.tenantId,
    required this.serverTime,
  });

  final bool ready;
  final PatientReadinessState? state;
  final PatientReadinessRouteKind? routeKind;
  final String? tenantId;
  final DateTime serverTime;

  factory PatientReadiness.fromJson(Map<String, dynamic> json) {
    final keys = json.keys.toSet();
    final unknownKeys = keys.difference(_allowedKeys);
    if (unknownKeys.isNotEmpty) {
      throw FormatException(
        'Unexpected patient-readiness fields: ${unknownKeys.join(', ')}',
      );
    }

    final contractVersion = json['readinessContractVersion'];
    final purpose = json['readinessPurpose'];
    final ready = json['ready'];
    if (contractVersion != PatientReadinessConfig.contractVersion ||
        purpose != PatientReadinessConfig.purpose ||
        ready is! bool) {
      throw const FormatException('Malformed patient-readiness response');
    }

    final expectedKeys = ready
        ? <String>{
            'readinessContractVersion',
            'readinessPurpose',
            'ready',
            'endpointId',
            'routeKind',
            'tenantId',
            'database',
            'serverTime',
          }
        : <String>{
            'readinessContractVersion',
            'readinessPurpose',
            'ready',
            'state',
            if (json.containsKey('routeKind')) 'routeKind',
            'serverTime',
          };
    if (keys.difference(expectedKeys).isNotEmpty ||
        expectedKeys.difference(keys).isNotEmpty) {
      throw const FormatException('Malformed patient-readiness field set');
    }

    final serverTimeRaw = json['serverTime'];
    if (serverTimeRaw is! String) {
      throw const FormatException('Malformed patient-readiness response');
    }
    final serverTime = DateTime.tryParse(serverTimeRaw);
    if (serverTime == null || !serverTime.isUtc) {
      throw const FormatException('Patient readiness serverTime must be UTC');
    }

    if (!ready) {
      return PatientReadiness(
        ready: false,
        state: _parseState(json['state']),
        routeKind: _parseRouteKind(json['routeKind']),
        tenantId: null,
        serverTime: serverTime,
      );
    }

    final tenantId = json['tenantId'];
    if (json['endpointId'] != PatientReadinessConfig.endpointId ||
        tenantId is! String ||
        tenantId.isEmpty ||
        json['database'] != 'ready') {
      throw const FormatException('Malformed ready response');
    }

    return PatientReadiness(
      ready: true,
      state: null,
      routeKind: _parseRequiredRouteKind(json['routeKind']),
      tenantId: tenantId,
      serverTime: serverTime,
    );
  }

  bool isReadyForTenant(String expectedTenantId) =>
      ready && tenantId == expectedTenantId && routeKind != null;

  static PatientReadinessRouteKind _parseRequiredRouteKind(Object? value) {
    final routeKind = _parseRouteKind(value);
    if (routeKind == null) {
      throw const FormatException('Missing patient-readiness routeKind');
    }
    return routeKind;
  }

  static PatientReadinessRouteKind? _parseRouteKind(Object? value) {
    return switch (value) {
      'public' => PatientReadinessRouteKind.public,
      'internal' => PatientReadinessRouteKind.internal,
      null => null,
      _ => throw const FormatException('Unknown patient-readiness routeKind'),
    };
  }

  static PatientReadinessState _parseState(Object? value) {
    return switch (value) {
      'endpoint_unverified' => PatientReadinessState.endpointUnverified,
      'database_unavailable' => PatientReadinessState.databaseUnavailable,
      _ => throw const FormatException('Unknown patient-readiness state'),
    };
  }
}
