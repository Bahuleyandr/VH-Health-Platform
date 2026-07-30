import 'dart:async';

import '../config/client_readiness_config.dart';
import '../config/tenant_config.dart';
import '../models/api_response.dart';
import '../models/client_readiness.dart';
import 'auth_service.dart';
import 'http_client.dart';

typedef ClientReadinessRequest = Future<ApiResponse> Function();
typedef ClientReadinessProbe = Future<ClientReadinessOutcome> Function();
typedef ClientReadinessDelay = Future<void> Function(Duration duration);
typedef ClientReadinessClock = DateTime Function();
typedef ClientReadinessIdentity = Future<String?> Function();

class ClientReadinessService {
  static final ClientReadinessService instance = ClientReadinessService._();

  final ClientReadinessRequest _request;
  final ClientReadinessDelay _delay;
  final ClientReadinessClock _clock;
  final ClientReadinessIdentity _tenantId;
  final ClientReadinessIdentity _staffId;
  final ClientReadinessIdentity _authentication;
  final Duration? _maxClockSkew;
  final Duration _successSpacing;

  bool _gateOpen = false;
  DateTime? _suppressedUntil;
  Future<ClientReadinessOutcome>? _inFlight;
  ClientReadinessOutcome _lastOutcome = ClientReadinessOutcome.notReady;

  ClientReadinessService._()
    : _request = _defaultRequest,
      _delay = Future<void>.delayed,
      _clock = DateTime.now,
      _tenantId = _configuredTenantId,
      _staffId = AuthService.getStaffId,
      _authentication = AuthService.getJwt,
      _maxClockSkew = ClientReadinessConfig.maxClockSkew,
      _successSpacing = const Duration(seconds: 1);

  ClientReadinessService.forTesting({
    required ClientReadinessRequest request,
    required ClientReadinessIdentity tenantId,
    required ClientReadinessIdentity staffId,
    ClientReadinessIdentity authentication = _authenticatedForTesting,
    Duration? maxClockSkew = const Duration(seconds: 300),
    Duration successSpacing = const Duration(seconds: 1),
    ClientReadinessDelay delay = Future<void>.delayed,
    ClientReadinessClock clock = DateTime.now,
  }) : _request = request,
       _delay = delay,
       _clock = clock,
       _tenantId = tenantId,
       _staffId = staffId,
       _authentication = authentication,
       _maxClockSkew = maxClockSkew,
       _successSpacing = successSpacing;

  ClientReadinessOutcome get lastOutcome => _lastOutcome;

  Future<ClientReadinessOutcome> ensureReady() {
    return _inFlight ??= _ensureReady().whenComplete(() => _inFlight = null);
  }

  Future<ClientReadinessOutcome> _ensureReady() async {
    final now = _clock().toUtc();
    if (_suppressedUntil != null && now.isBefore(_suppressedUntil!)) {
      return _record(
        ClientReadinessOutcome(
          ready: false,
          lifecycle: ContinuityLifecycleState.rateLimited,
          retryAfter: _suppressedUntil!.difference(now),
        ),
      );
    }

    final authentication = await _authentication();
    final staffId = await _staffId();
    final tenantId = await _tenantId();
    if (authentication == null ||
        authentication.isEmpty ||
        staffId == null ||
        staffId.isEmpty ||
        tenantId == null ||
        tenantId.isEmpty) {
      return _fail(ContinuityLifecycleState.signedOut);
    }
    if (_maxClockSkew == null) {
      return _fail(ContinuityLifecycleState.clockUncertain);
    }

    final first = await _probeOnce(
      expectedAuthentication: authentication,
      expectedStaffId: staffId,
      expectedTenantId: tenantId,
      maxClockSkew: _maxClockSkew,
    );
    if (!first.ready || _gateOpen) return first;

    await _delay(_successSpacing);
    final secondAuthentication = await _authentication();
    final secondStaffId = await _staffId();
    final secondTenantId = await _tenantId();
    if (secondAuthentication != authentication ||
        secondStaffId != staffId ||
        secondTenantId != tenantId) {
      return _fail(ContinuityLifecycleState.signedOut);
    }

    final second = await _probeOnce(
      expectedAuthentication: authentication,
      expectedStaffId: staffId,
      expectedTenantId: tenantId,
      maxClockSkew: _maxClockSkew,
    );
    if (!second.ready ||
        first.routeKind != second.routeKind ||
        first.routeKind == null) {
      return _fail(second.lifecycle, clockSkew: second.clockSkew);
    }

    _gateOpen = true;
    return _record(second);
  }

  Future<ClientReadinessOutcome> _probeOnce({
    required String expectedAuthentication,
    required String expectedStaffId,
    required String expectedTenantId,
    required Duration maxClockSkew,
  }) async {
    final wallStart = _clock().toUtc();
    final monotonic = Stopwatch()..start();
    ApiResponse response;
    try {
      response = await _request();
    } catch (_) {
      return _fail(ContinuityLifecycleState.notReady);
    } finally {
      monotonic.stop();
    }

    if (await _authentication() != expectedAuthentication ||
        await _staffId() != expectedStaffId ||
        await _tenantId() != expectedTenantId) {
      return _fail(ContinuityLifecycleState.signedOut);
    }

    if (response.statusCode == 401) {
      return _fail(ContinuityLifecycleState.signedOut);
    }

    if (response.statusCode == 429) {
      final retryAfter = _parseRetryAfter(response.raw);
      if (retryAfter != null) {
        _suppressedUntil = _clock().toUtc().add(retryAfter);
      }
      return _fail(
        ContinuityLifecycleState.rateLimited,
        retryAfter: retryAfter,
      );
    }

    final raw = _readinessBody(response);
    if (raw == null) return _fail(ContinuityLifecycleState.notReady);

    ClientReadiness readiness;
    try {
      readiness = ClientReadiness.fromJson(raw);
    } on FormatException {
      return _fail(ContinuityLifecycleState.notReady);
    }

    if (!readiness.isReadyForTenant(expectedTenantId)) {
      return _fail(
        readiness.state == ClientReadinessState.policyIncompatible
            ? ContinuityLifecycleState.policyIncompatible
            : ContinuityLifecycleState.notReady,
      );
    }

    final estimatedLocalAtResponse = wallStart.add(
      Duration(microseconds: monotonic.elapsedMicroseconds ~/ 2),
    );
    final skew = readiness.serverTime
        .difference(estimatedLocalAtResponse)
        .abs();
    if (skew > maxClockSkew) {
      return _fail(ContinuityLifecycleState.clockUncertain, clockSkew: skew);
    }

    return _record(
      ClientReadinessOutcome(
        ready: true,
        lifecycle: readiness.routeKind == ClientReadinessRouteKind.internal
            ? ContinuityLifecycleState.readyInternal
            : ContinuityLifecycleState.readyPublic,
        routeKind: readiness.routeKind,
        clockSkew: skew,
      ),
    );
  }

  void closeForTransportLoss() {
    _gateOpen = false;
    _lastOutcome = ClientReadinessOutcome.notReady;
  }

  void resetForTesting() {
    _gateOpen = false;
    _suppressedUntil = null;
    _inFlight = null;
    _lastOutcome = ClientReadinessOutcome.notReady;
  }

  ClientReadinessOutcome _fail(
    ContinuityLifecycleState lifecycle, {
    Duration? clockSkew,
    Duration? retryAfter,
  }) {
    _gateOpen = false;
    return _record(
      ClientReadinessOutcome(
        ready: false,
        lifecycle: lifecycle,
        clockSkew: clockSkew,
        retryAfter: retryAfter,
      ),
    );
  }

  ClientReadinessOutcome _record(ClientReadinessOutcome outcome) {
    _lastOutcome = outcome;
    return outcome;
  }

  static Map<String, dynamic>? _readinessBody(ApiResponse response) {
    if (response.isSuccess && response.data is Map) {
      return Map<String, dynamic>.from(response.data as Map);
    }
    final raw = response.raw;
    if (raw is Map && raw['details'] is Map) {
      final details = raw['details'] as Map;
      if (details['readiness'] is Map) {
        return Map<String, dynamic>.from(details['readiness'] as Map);
      }
    }
    return null;
  }

  static Duration? _parseRetryAfter(Object? raw) {
    if (raw is! Map) return null;
    final value = raw['retryAfterSeconds'];
    final seconds = value is int
        ? value
        : int.tryParse(value?.toString() ?? '');
    if (seconds == null || seconds <= 0) return null;
    return Duration(seconds: seconds);
  }

  static Future<ApiResponse> _defaultRequest() {
    return VHHttpClient.get(
      ClientReadinessConfig.path,
      timeout: const Duration(seconds: 10),
    );
  }

  static Future<String?> _configuredTenantId() async => TenantConfig.id;

  static Future<String?> _authenticatedForTesting() async => 'authenticated';
}
