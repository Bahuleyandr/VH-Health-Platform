import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/outage/patient_mutation_policy.dart';
import 'package:vhhealth/core/outage/patient_readiness.dart';
import 'package:vhhealth/core/services/connectivity_service.dart';
import 'package:vhhealth/core/services/patient_session_authority.dart';
import 'package:vhhealth_core/config/client_readiness_config.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/http_client.dart';

enum PatientOutageStatus { signedOut, checking, available, outage }

enum PatientOutageReason {
  none,
  transportUnavailable,
  endpointUnverified,
  databaseUnavailable,
  clockUncertain,
  rateLimited,
  malformedReadiness,
  probeForbidden,
}

@immutable
class PatientBlockedMutation {
  const PatientBlockedMutation({
    required this.method,
    required this.path,
    required this.category,
  });

  final String method;
  final String path;
  final PatientMutationCategory category;
}

typedef PatientReadinessRequest = Future<ApiResponse> Function();
typedef PatientIdentity = Future<String?> Function();
typedef PatientDelay = Future<void> Function(Duration duration);
typedef PatientClock = DateTime Function();
typedef PatientSessionConfirmation = Future<bool> Function(
  String jwt,
  String tenantId,
  DateTime confirmedAt,
);

class PatientOutageController extends ChangeNotifier {
  PatientOutageController._production()
    : _request = _defaultRequest,
      _authentication = AuthService.getJwt,
      _tenantId = _configuredTenantId,
      _delay = Future<void>.delayed,
      _clock = DateTime.now,
      _confirmSession = _defaultConfirmSession,
      _successSpacing = const Duration(seconds: 1),
      _maxClockSkew =
          ClientReadinessConfig.maxClockSkew ??
          const Duration(
            seconds: ClientReadinessConfig.ownerApprovedMaxClockSkewSeconds,
          );

  @visibleForTesting
  PatientOutageController.forTesting({
    required PatientReadinessRequest request,
    required PatientIdentity authentication,
    required PatientIdentity tenantId,
    required Duration maxClockSkew,
    PatientDelay delay = Future<void>.delayed,
    PatientClock clock = DateTime.now,
    Duration successSpacing = const Duration(seconds: 1),
    PatientSessionConfirmation confirmSession = _defaultConfirmSession,
  }) : _request = request,
       _authentication = authentication,
       _tenantId = tenantId,
       _delay = delay,
       _clock = clock,
       _confirmSession = confirmSession,
       _successSpacing = successSpacing,
       _maxClockSkew = maxClockSkew;

  static PatientOutageController _active =
      PatientOutageController._production();

  static PatientOutageController get instance => _active;

  @visibleForTesting
  static void setForTesting(PatientOutageController controller) {
    _active = controller;
  }

  @visibleForTesting
  static void resetAfterTesting() {
    _active = PatientOutageController._production();
  }

  final PatientReadinessRequest _request;
  final PatientIdentity _authentication;
  final PatientIdentity _tenantId;
  final PatientDelay _delay;
  final PatientClock _clock;
  final PatientSessionConfirmation _confirmSession;
  final Duration _successSpacing;
  final Duration _maxClockSkew;
  final _blockedMutations =
      StreamController<PatientBlockedMutation>.broadcast();

  static const _recoveryDelays = <Duration>[
    Duration(seconds: 5),
    Duration(seconds: 15),
    Duration(seconds: 30),
    Duration(seconds: 60),
  ];

  PatientOutageStatus _status = PatientOutageStatus.signedOut;
  PatientOutageReason _reason = PatientOutageReason.none;
  Future<bool>? _inFlight;
  StreamSubscription<bool>? _connectivitySubscription;
  Timer? _recoveryTimer;
  DateTime? _suppressedUntil;
  int _recoveryAttempt = 0;
  bool _foreground = true;
  PatientOutageReason? _lastProbeFailureReason;

  PatientOutageStatus get status => _status;
  PatientOutageReason get reason => _reason;
  bool get isOutage => _status == PatientOutageStatus.outage;
  bool get isChecking => _status == PatientOutageStatus.checking;
  bool get blocksHospitalMutations => isOutage || isChecking;
  Stream<PatientBlockedMutation> get blockedMutations =>
      _blockedMutations.stream;

  Future<void> initialize() async {
    _connectivitySubscription ??= ConnectivityService.onChange.listen(
      handleConnectivityChanged,
    );
    await refreshForCurrentSession();
  }

  Future<bool> refreshForCurrentSession() async {
    final authentication = await _authentication();
    if (authentication == null || authentication.isEmpty) {
      _setState(PatientOutageStatus.signedOut, PatientOutageReason.none);
      return false;
    }
    if (_status == PatientOutageStatus.available) return true;
    return probeNow();
  }

  Future<bool> probeNow() => _inFlight ??= _probe().whenComplete(() {
    _inFlight = null;
  });

  Future<bool> _probe() async {
    _lastProbeFailureReason = null;
    final now = _clock().toUtc();
    if (_suppressedUntil != null && now.isBefore(_suppressedUntil!)) {
      _close(PatientOutageReason.rateLimited);
      return false;
    }

    final authentication = await _authentication();
    final tenantId = await _tenantId();
    if (authentication == null ||
        authentication.isEmpty ||
        tenantId == null ||
        tenantId.isEmpty) {
      _setState(PatientOutageStatus.signedOut, PatientOutageReason.none);
      return false;
    }

    if (!isOutage) {
      _setState(PatientOutageStatus.checking, PatientOutageReason.none);
    }

    final first = await _probeOnce(
      expectedAuthentication: authentication,
      expectedTenantId: tenantId,
    );
    if (!first.ready) {
      _applyFailure(first);
      return false;
    }

    await _delay(_successSpacing);
    if (await _authentication() != authentication ||
        await _tenantId() != tenantId) {
      _setState(PatientOutageStatus.signedOut, PatientOutageReason.none);
      return false;
    }

    final second = await _probeOnce(
      expectedAuthentication: authentication,
      expectedTenantId: tenantId,
    );
    if (!second.ready ||
        second.routeKind == null ||
        second.routeKind != first.routeKind) {
      _applyFailure(second);
      return false;
    }

    _recoveryTimer?.cancel();
    _recoveryTimer = null;
    _recoveryAttempt = 0;
    _suppressedUntil = null;
    try {
      await _confirmSession(authentication, tenantId, second.serverTime!);
    } catch (error) {
      if (kDebugMode) {
        debugPrint('Patient offline lease persistence failed: $error');
      }
    }
    _setState(PatientOutageStatus.available, PatientOutageReason.none);
    return true;
  }

  Future<_PatientReadinessOutcome> _probeOnce({
    required String expectedAuthentication,
    required String expectedTenantId,
  }) async {
    final wallStart = _clock().toUtc();
    final monotonic = Stopwatch()..start();
    ApiResponse response;
    try {
      response = await _request();
    } catch (_) {
      _lastProbeFailureReason = PatientOutageReason.transportUnavailable;
      return const _PatientReadinessOutcome(
        reason: PatientOutageReason.transportUnavailable,
      );
    } finally {
      monotonic.stop();
    }

    if (await _authentication() != expectedAuthentication ||
        await _tenantId() != expectedTenantId) {
      return const _PatientReadinessOutcome(signedOut: true);
    }
    if (response.statusCode == 401) {
      return const _PatientReadinessOutcome(signedOut: true);
    }
    // 403 is an authoritative refusal, not a malformed body. Without this
    // branch it fell through to the body parse, found no `details.readiness`,
    // and closed as `malformedReadiness` — which is why a role gate that
    // excluded PATIENT looked like a parser fault instead of an authorization
    // one. C-D12 section 5.2 keeps the refusal fail-closed; the distinct
    // reason exists so a recurrence is diagnosable rather than silent.
    if (response.statusCode == 403) {
      _lastProbeFailureReason = PatientOutageReason.probeForbidden;
      return const _PatientReadinessOutcome(
        reason: PatientOutageReason.probeForbidden,
      );
    }
    if (response.statusCode == 429) {
      final retryAfter = _parseRetryAfter(response.raw);
      if (retryAfter != null) {
        _suppressedUntil = _clock().toUtc().add(retryAfter);
      }
      return _PatientReadinessOutcome(reason: PatientOutageReason.rateLimited);
    }

    final raw = _readinessBody(response);
    if (raw == null) {
      _lastProbeFailureReason = PatientOutageReason.malformedReadiness;
      return const _PatientReadinessOutcome(
        reason: PatientOutageReason.malformedReadiness,
      );
    }

    PatientReadiness readiness;
    try {
      readiness = PatientReadiness.fromJson(raw);
    } on FormatException {
      _lastProbeFailureReason = PatientOutageReason.malformedReadiness;
      return const _PatientReadinessOutcome(
        reason: PatientOutageReason.malformedReadiness,
      );
    }

    if (!readiness.isReadyForTenant(expectedTenantId)) {
      _lastProbeFailureReason = _reasonForReadiness(readiness);
      return _PatientReadinessOutcome(reason: _reasonForReadiness(readiness));
    }

    final estimatedLocalAtResponse = wallStart.add(
      Duration(microseconds: monotonic.elapsedMicroseconds ~/ 2),
    );
    final skew = readiness.serverTime
        .difference(estimatedLocalAtResponse)
        .abs();
    if (skew > _maxClockSkew) {
      return _PatientReadinessOutcome(
        reason: PatientOutageReason.clockUncertain,
      );
    }

    return _PatientReadinessOutcome(
      ready: true,
      routeKind: readiness.routeKind,
      serverTime: readiness.serverTime,
    );
  }

  Future<void> observeResponse(ApiResponse response) async {
    if (response.statusCode == 401) {
      _setState(PatientOutageStatus.signedOut, PatientOutageReason.none);
      return;
    }
    if (response.statusCode != 503) return;

    final raw = _readinessBody(response);
    if (raw != null) {
      try {
        final readiness = PatientReadiness.fromJson(raw);
        if (!readiness.ready) {
          _close(_reasonForReadiness(readiness));
          return;
        }
      } on FormatException {
        _close(PatientOutageReason.malformedReadiness);
        return;
      }
    }
    await probeNow();
  }

  void observeTransportFailure() {
    unawaited(probeNow());
  }

  void handleConnectivityChanged(bool online) {
    if (!online) {
      if (_status == PatientOutageStatus.signedOut) return;
      _close(PatientOutageReason.transportUnavailable);
      return;
    }
    if (isOutage || isChecking) unawaited(probeNow());
  }

  void onBackgrounded() {
    _foreground = false;
    _recoveryTimer?.cancel();
    _recoveryTimer = null;
  }

  void onResumed() {
    _foreground = true;
    if (_status != PatientOutageStatus.signedOut) {
      _setState(PatientOutageStatus.checking, PatientOutageReason.none);
    }
    unawaited(_recheckAfterResume());
  }

  Future<void> _recheckAfterResume() async {
    final authentication = await _authentication();
    if (authentication == null || authentication.isEmpty) {
      _setState(PatientOutageStatus.signedOut, PatientOutageReason.none);
      return;
    }
    _setState(PatientOutageStatus.checking, PatientOutageReason.none);
    await probeNow();
  }

  void reportBlockedMutation(String method, String path) {
    _blockedMutations.add(
      PatientBlockedMutation(
        method: method,
        path: path,
        category: PatientMutationPolicy.classify(method, path),
      ),
    );
  }

  void _applyFailure(_PatientReadinessOutcome outcome) {
    if (outcome.signedOut) {
      _setState(PatientOutageStatus.signedOut, PatientOutageReason.none);
      return;
    }
    final reason =
        outcome.reason ??
        _lastProbeFailureReason ??
        PatientOutageReason.transportUnavailable;
    _close(reason);
  }

  void _close(PatientOutageReason reason) {
    _setState(PatientOutageStatus.outage, reason);
    _scheduleRecovery();
  }

  void _scheduleRecovery() {
    if (!_foreground || _recoveryTimer != null) return;
    final now = _clock().toUtc();
    final delay = _suppressedUntil != null && now.isBefore(_suppressedUntil!)
        ? _suppressedUntil!.difference(now)
        : _recoveryDelays[_recoveryAttempt.clamp(
            0,
            _recoveryDelays.length - 1,
          )];
    if (_recoveryAttempt < _recoveryDelays.length - 1) {
      _recoveryAttempt += 1;
    }
    _recoveryTimer = Timer(delay, () {
      _recoveryTimer = null;
      unawaited(probeNow());
    });
  }

  void _setState(PatientOutageStatus status, PatientOutageReason reason) {
    if (_status == status && _reason == reason) return;
    _status = status;
    _reason = reason;
    notifyListeners();
  }

  static PatientOutageReason _reasonForReadiness(PatientReadiness readiness) {
    return switch (readiness.state) {
      PatientReadinessState.endpointUnverified =>
        PatientOutageReason.endpointUnverified,
      PatientReadinessState.databaseUnavailable =>
        PatientOutageReason.databaseUnavailable,
      null => PatientOutageReason.malformedReadiness,
    };
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

  static Future<ApiResponse> _defaultRequest() => VHHttpClient.get(
    PatientReadinessConfig.path,
    timeout: const Duration(seconds: 10),
  );

  static Future<String?> _configuredTenantId() async => TenantConfig.id;

  static Future<bool> _defaultConfirmSession(
    String jwt,
    String tenantId,
    DateTime confirmedAt,
  ) => PatientSessionAuthority.instance.confirmServerSession(
    jwt: jwt,
    tenantId: tenantId,
    confirmedAt: confirmedAt,
  );

  @visibleForTesting
  void closeForTesting(PatientOutageReason reason) => _close(reason);

  @visibleForTesting
  void markAvailableForTesting() {
    _recoveryTimer?.cancel();
    _recoveryTimer = null;
    _setState(PatientOutageStatus.available, PatientOutageReason.none);
  }

  @override
  void dispose() {
    _connectivitySubscription?.cancel();
    _recoveryTimer?.cancel();
    _blockedMutations.close();
    super.dispose();
  }
}

class _PatientReadinessOutcome {
  const _PatientReadinessOutcome({
    this.ready = false,
    this.signedOut = false,
    this.routeKind,
    this.serverTime,
    this.reason,
  });

  final bool ready;
  final bool signedOut;
  final PatientReadinessRouteKind? routeKind;
  final DateTime? serverTime;
  final PatientOutageReason? reason;
}
