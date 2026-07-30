import '../config/client_readiness_config.dart';

enum ClientReadinessRouteKind { public, internal }

enum ClientTransportState { unknown, available, unavailable }

enum ContinuityLifecycleState {
  signedOut,
  checking,
  notReady,
  clockUncertain,
  policyIncompatible,
  readyPublic,
  readyInternal,
  rateLimited,
  syncing,
  reviewRequired,
}

enum ClientReadinessState {
  endpointUnverified,
  databaseUnavailable,
  policyUnavailable,
  policyIncompatible,
}

class ClientReadinessPolicy {
  final String state;
  final int schemaVersion;

  const ClientReadinessPolicy({
    required this.state,
    required this.schemaVersion,
  });
}

/// Strict, low-information response from the authenticated readiness route.
class ClientReadiness {
  static const Set<String> _allowedKeys = {
    'readinessContractVersion',
    'ready',
    'state',
    'endpointId',
    'routeKind',
    'tenantId',
    'database',
    'policy',
    'serverTime',
  };

  final int contractVersion;
  final bool ready;
  final ClientReadinessState? state;
  final String? endpointId;
  final ClientReadinessRouteKind? routeKind;
  final String? tenantId;
  final String? database;
  final ClientReadinessPolicy? policy;
  final DateTime serverTime;

  const ClientReadiness({
    required this.contractVersion,
    required this.ready,
    required this.state,
    required this.endpointId,
    required this.routeKind,
    required this.tenantId,
    required this.database,
    required this.policy,
    required this.serverTime,
  });

  factory ClientReadiness.fromJson(Map<String, dynamic> json) {
    final unknownKeys = json.keys.toSet().difference(_allowedKeys);
    if (unknownKeys.isNotEmpty) {
      throw FormatException(
        'Unexpected client-readiness fields: ${unknownKeys.join(', ')}',
      );
    }

    final contractVersion = json['readinessContractVersion'];
    final ready = json['ready'];
    if (contractVersion is! int || ready is! bool) {
      throw const FormatException('Malformed client-readiness response');
    }

    final expectedKeys = ready
        ? <String>{
            'readinessContractVersion',
            'ready',
            'endpointId',
            'routeKind',
            'tenantId',
            'database',
            'policy',
            'serverTime',
          }
        : <String>{
            'readinessContractVersion',
            'ready',
            'state',
            if (json.containsKey('routeKind')) 'routeKind',
            'serverTime',
          };
    if (json.keys.toSet().difference(expectedKeys).isNotEmpty ||
        expectedKeys.difference(json.keys.toSet()).isNotEmpty) {
      throw const FormatException('Malformed client-readiness field set');
    }

    final state = ready ? null : _parseState(json['state']);
    final endpointId = json['endpointId'];
    final tenantId = json['tenantId'];
    final database = json['database'];
    final policyJson = json['policy'];
    final serverTimeRaw = json['serverTime'];
    if (serverTimeRaw is! String) {
      throw const FormatException('Malformed client-readiness response');
    }

    ClientReadinessPolicy? parsedPolicy;
    if (ready) {
      if (endpointId is! String ||
          endpointId.isEmpty ||
          tenantId is! String ||
          tenantId.isEmpty ||
          database is! String ||
          policyJson is! Map) {
        throw const FormatException('Malformed ready response');
      }
      final policy = Map<String, dynamic>.from(policyJson);
      const allowedPolicyKeys = {'state', 'schemaVersion'};
      final policyKeys = policy.keys.toSet();
      if (policyKeys.difference(allowedPolicyKeys).isNotEmpty ||
          allowedPolicyKeys.difference(policyKeys).isNotEmpty ||
          policy['state'] is! String ||
          policy['schemaVersion'] is! int) {
        throw const FormatException('Malformed readiness policy response');
      }
      parsedPolicy = ClientReadinessPolicy(
        state: policy['state'] as String,
        schemaVersion: policy['schemaVersion'] as int,
      );
    }

    final parsedServerTime = DateTime.tryParse(serverTimeRaw);
    if (parsedServerTime == null || !parsedServerTime.isUtc) {
      throw const FormatException('Readiness serverTime must include UTC');
    }

    final routeKind = _parseRouteKind(json['routeKind']);
    return ClientReadiness(
      contractVersion: contractVersion,
      ready: ready,
      state: state,
      endpointId: endpointId,
      routeKind: routeKind,
      tenantId: tenantId,
      database: database,
      policy: parsedPolicy,
      serverTime: parsedServerTime,
    );
  }

  bool isReadyForTenant(String expectedTenantId) {
    return ready &&
        state == null &&
        contractVersion == ClientReadinessConfig.contractVersion &&
        endpointId == ClientReadinessConfig.endpointId &&
        tenantId == expectedTenantId &&
        routeKind != null &&
        database == 'ready' &&
        policy?.state == 'compatible' &&
        policy?.schemaVersion == ClientReadinessConfig.policySchemaVersion;
  }

  static ClientReadinessRouteKind? _parseRouteKind(Object? value) {
    return switch (value) {
      'public' => ClientReadinessRouteKind.public,
      'internal' => ClientReadinessRouteKind.internal,
      null => null,
      _ => throw const FormatException('Unknown readiness routeKind'),
    };
  }

  static ClientReadinessState _parseState(Object? value) {
    return switch (value) {
      'endpoint_unverified' => ClientReadinessState.endpointUnverified,
      'database_unavailable' => ClientReadinessState.databaseUnavailable,
      'policy_unavailable' => ClientReadinessState.policyUnavailable,
      'policy_incompatible' => ClientReadinessState.policyIncompatible,
      _ => throw const FormatException('Unknown readiness state'),
    };
  }
}

class ClientReadinessOutcome {
  final bool ready;
  final ContinuityLifecycleState lifecycle;
  final ClientReadinessRouteKind? routeKind;
  final Duration? clockSkew;
  final Duration? retryAfter;

  const ClientReadinessOutcome({
    required this.ready,
    required this.lifecycle,
    this.routeKind,
    this.clockSkew,
    this.retryAfter,
  });

  static const notReady = ClientReadinessOutcome(
    ready: false,
    lifecycle: ContinuityLifecycleState.notReady,
  );

  static const alwaysReadyForTesting = ClientReadinessOutcome(
    ready: true,
    lifecycle: ContinuityLifecycleState.readyPublic,
    routeKind: ClientReadinessRouteKind.public,
  );
}
