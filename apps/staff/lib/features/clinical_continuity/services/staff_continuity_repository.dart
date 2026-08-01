import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:local_auth/local_auth.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

enum StaffContinuityState { disabled, idle, refreshing, ready, locked, refused }

abstract interface class StaffContinuityDeviceUnlocker {
  Future<ClinicalContinuityLocalFactor?> unlock();
}

class LocalAuthStaffContinuityUnlocker
    implements StaffContinuityDeviceUnlocker {
  final LocalAuthentication _authentication;

  LocalAuthStaffContinuityUnlocker({LocalAuthentication? authentication})
    : _authentication = authentication ?? LocalAuthentication();

  @override
  Future<ClinicalContinuityLocalFactor?> unlock() async {
    try {
      final success = await _authentication.authenticate(
        localizedReason:
            'Unlock the read-only VH Health continuity pack on this device',
        biometricOnly: false,
        sensitiveTransaction: true,
        persistAcrossBackgrounding: true,
      );
      return success
          ? ClinicalContinuityLocalFactor.devicePinOrBiometric
          : null;
    } catch (_) {
      return null;
    }
  }
}

class StaffContinuityRepository extends ChangeNotifier {
  static StaffContinuityRepository instance = StaffContinuityRepository(
    source: const _UnavailableClinicalContinuitySource(),
  );

  final ClinicalContinuitySource _source;
  final ClinicalContinuityVerifier _verifier;
  final ClinicalContinuityCache _cache;
  final ClientReadinessProbe _readiness;
  final StaffContinuityDeviceUnlocker _unlocker;
  final bool _cacheEnabled;
  final bool _localUnlockEnabled;
  final Duration _refreshInterval;

  StaffContinuityState _state;
  String? _refusalReason;
  VerifiedClinicalContinuitySet? _currentSet;
  Future<bool>? _refreshInFlight;
  Timer? _refreshTimer;
  DateTime? _trustedAnchor;
  Stopwatch? _trustedElapsed;
  bool _disposed = false;

  StaffContinuityRepository({
    required ClinicalContinuitySource source,
    ClinicalContinuityVerifier? verifier,
    ClinicalContinuityCache? cache,
    ClientReadinessProbe? readiness,
    StaffContinuityDeviceUnlocker? unlocker,
    bool cacheEnabled = TenantConfig.clinicalContinuityCacheEnabled,
    bool localUnlockEnabled = TenantConfig.clinicalContinuityLocalUnlockEnabled,
    Duration refreshInterval = const Duration(minutes: 15),
  }) : _source = source,
       _verifier = verifier ?? ClinicalContinuityVerifier(),
       _cache = cache ?? ClinicalContinuityCache(),
       _readiness = readiness ?? ClientReadinessService.instance.ensureReady,
       _unlocker = unlocker ?? LocalAuthStaffContinuityUnlocker(),
       _cacheEnabled = cacheEnabled,
       _localUnlockEnabled = localUnlockEnabled,
       _refreshInterval = refreshInterval,
       _state = cacheEnabled
           ? StaffContinuityState.idle
           : StaffContinuityState.disabled;

  StaffContinuityState get state => _state;
  String? get refusalReason => _refusalReason;
  VerifiedClinicalContinuitySet? get currentSet => _currentSet;
  bool get cacheEnabled => _cacheEnabled;
  bool get localUnlockEnabled => _localUnlockEnabled;
  ClinicalContinuityClockAssessment get trustedClockAssessment {
    final anchor = _trustedAnchor;
    final elapsed = _trustedElapsed;
    return ClinicalContinuityClockAssessment(
      trusted: anchor != null && elapsed != null,
      trustedNow: anchor == null || elapsed == null
          ? null
          : anchor.add(elapsed.elapsed),
      minimumTrustedNow: anchor,
    );
  }

  Future<bool> requestRefresh() {
    if (!_cacheEnabled || _disposed) return Future.value(false);
    return _refreshInFlight ??= _refresh().whenComplete(
      () => _refreshInFlight = null,
    );
  }

  Future<bool> _refresh() async {
    final readiness = await _readiness();
    if (!readiness.ready) {
      _stopPeriodicRefresh();
      _setState(
        readiness.lifecycle == ContinuityLifecycleState.clockUncertain
            ? StaffContinuityState.refused
            : StaffContinuityState.idle,
        reason: readiness.lifecycle == ContinuityLifecycleState.clockUncertain
            ? ClinicalContinuityVerificationReasons.clockUncertain
            : null,
      );
      return false;
    }
    _setState(StaffContinuityState.refreshing);
    try {
      final snapshot = await _source.fetchFacilitySet();
      final floors = await _cache.readFloors(
        tenantId: snapshot.session.tenantId,
        facilityId: snapshot.session.facilityId,
      );
      final verification = await _verifier.verify(
        snapshot,
        persistedFloors: floors,
      );
      if (!verification.ok || verification.verifiedSet == null) {
        _setState(StaffContinuityState.refused, reason: verification.reason);
        return false;
      }
      final stored = await _cache.store(verification.verifiedSet!);
      if (!stored.stored) {
        _setState(StaffContinuityState.refused, reason: stored.denialReason);
        return false;
      }
      _currentSet = verification.verifiedSet;
      _anchorTrustedClock(verification.verifiedSet!.evaluatedAt);
      _setState(StaffContinuityState.ready);
      _startPeriodicRefresh();
      return true;
    } catch (_) {
      // A failed refresh never mutates or extends the currently verified set.
      _setState(
        _currentSet == null
            ? StaffContinuityState.idle
            : StaffContinuityState.ready,
      );
      return false;
    }
  }

  Future<ClinicalContinuityAccessDecision> openCached() async {
    if (!_cacheEnabled) {
      return const ClinicalContinuityAccessDecision.denied('CACHE_DISABLED');
    }
    var session = await _source.currentSession();
    if (session == null) {
      _setState(StaffContinuityState.refused, reason: 'NAMED_SESSION_REQUIRED');
      return const ClinicalContinuityAccessDecision.denied(
        'NAMED_SESSION_REQUIRED',
      );
    }
    final clock = await _source.assessClock();
    final readiness = await _readiness();
    if (readiness.ready && !await requestRefresh()) {
      _setState(
        StaffContinuityState.refused,
        reason: 'ONLINE_REAUTHORIZATION_REQUIRED',
      );
      return const ClinicalContinuityAccessDecision.denied(
        'ONLINE_REAUTHORIZATION_REQUIRED',
      );
    }
    if (readiness.ready) {
      final refreshedSession = await _source.currentSession();
      if (refreshedSession == null ||
          !_sameSessionInstance(session, refreshedSession)) {
        _setState(
          StaffContinuityState.refused,
          reason: 'ONLINE_REAUTHORIZATION_REQUIRED',
        );
        return const ClinicalContinuityAccessDecision.denied(
          'ONLINE_REAUTHORIZATION_REQUIRED',
        );
      }
      session = refreshedSession;
    }
    final cached = await _cache.open(session: session, clock: clock);
    if (!cached.found ||
        cached.verifiedSet == null ||
        cached.denialReason != null) {
      final reason = cached.denialReason ?? 'CACHE_NOT_AVAILABLE';
      _setState(StaffContinuityState.refused, reason: reason);
      return ClinicalContinuityAccessDecision.denied(reason);
    }
    final set = cached.verifiedSet!;
    if (readiness.ready) {
      final activeSession = await _source.currentSession();
      if (activeSession == null ||
          !_sameSessionInstance(session, activeSession) ||
          !_sameNamedSession(set.prefetchSession, activeSession)) {
        _setState(
          StaffContinuityState.refused,
          reason: 'ONLINE_REAUTHORIZATION_REQUIRED',
        );
        return const ClinicalContinuityAccessDecision.denied(
          'ONLINE_REAUTHORIZATION_REQUIRED',
        );
      }
      _currentSet = set;
      _anchorTrustedClock(clock.trustedNow!);
      _setState(StaffContinuityState.ready);
      return ClinicalContinuityAccessDecision.allowed(
        mode: ClinicalContinuityAccessMode.onlineAuthenticated,
        verifiedSet: set,
      );
    }

    final policy = set.localUnlockPolicy;
    if (!_localUnlockEnabled || !policy.isComplete) {
      _setState(
        StaffContinuityState.locked,
        reason: 'LOCAL_UNLOCK_POLICY_UNAVAILABLE',
      );
      return const ClinicalContinuityAccessDecision.denied(
        'LOCAL_UNLOCK_POLICY_UNAVAILABLE',
      );
    }
    final trustedNow = clock.trustedNow?.toUtc();
    final authenticatedAt = session.authenticatedAt.toUtc();
    if (trustedNow == null ||
        trustedNow.isBefore(authenticatedAt) ||
        trustedNow.difference(authenticatedAt) >
            Duration(minutes: policy.maximumAuthorizationMinutes)) {
      _setState(
        StaffContinuityState.locked,
        reason: 'LOCAL_AUTHORIZATION_EXPIRED',
      );
      return const ClinicalContinuityAccessDecision.denied(
        'LOCAL_AUTHORIZATION_EXPIRED',
      );
    }
    if (!_hasLocalGrantCoverage(set, session, trustedNow)) {
      _setState(
        StaffContinuityState.locked,
        reason: 'LOCAL_UNLOCK_POLICY_UNAVAILABLE',
      );
      return const ClinicalContinuityAccessDecision.denied(
        'LOCAL_UNLOCK_POLICY_UNAVAILABLE',
      );
    }
    final factor = await _unlocker.unlock();
    if (factor == null) {
      _setState(
        StaffContinuityState.locked,
        reason: 'DEVICE_BOUND_FACTOR_REQUIRED',
      );
      return const ClinicalContinuityAccessDecision.denied(
        'DEVICE_BOUND_FACTOR_REQUIRED',
      );
    }
    final activeSession = await _source.currentSession();
    if (activeSession == null ||
        !_sameSessionInstance(session, activeSession)) {
      _setState(StaffContinuityState.locked, reason: 'NAMED_SESSION_REQUIRED');
      return const ClinicalContinuityAccessDecision.denied(
        'NAMED_SESSION_REQUIRED',
      );
    }
    _currentSet = set;
    _anchorTrustedClock(clock.trustedNow!);
    _setState(StaffContinuityState.ready);
    return ClinicalContinuityAccessDecision.allowed(
      mode: ClinicalContinuityAccessMode.localUnlock,
      verifiedSet: set,
    );
  }

  Future<void> onAuthenticatedLogin() => requestRefresh();

  Future<void> onAppForeground() => requestRefresh();

  Future<void> onTrustBundleChanged() => requestRefresh();

  Future<void> onFacilityChanged() async {
    await clearDecryptedState();
    await requestRefresh();
  }

  Future<void> clearDecryptedState() async {
    _currentSet = null;
    _clearTrustedClock();
    _stopPeriodicRefresh();
    await _source.cancel();
    if (_cacheEnabled) _setState(StaffContinuityState.idle);
  }

  Future<void> governedWipeFacility({
    required String tenantId,
    required String facilityId,
  }) async {
    await clearDecryptedState();
    await _cache.wipeFacility(tenantId: tenantId, facilityId: facilityId);
  }

  Future<void> governedWipeDevice() async {
    await clearDecryptedState();
    await _cache.wipeDevice();
  }

  void _startPeriodicRefresh() {
    _refreshTimer ??= Timer.periodic(
      _refreshInterval,
      (_) => unawaited(requestRefresh()),
    );
  }

  void _stopPeriodicRefresh() {
    _refreshTimer?.cancel();
    _refreshTimer = null;
  }

  void _setState(StaffContinuityState state, {String? reason}) {
    _state = state;
    _refusalReason = reason;
    if (!_disposed) notifyListeners();
  }

  void _anchorTrustedClock(DateTime value) {
    _trustedElapsed?.stop();
    _trustedAnchor = value.toUtc();
    _trustedElapsed = Stopwatch()..start();
  }

  void _clearTrustedClock() {
    _trustedElapsed?.stop();
    _trustedElapsed = null;
    _trustedAnchor = null;
  }

  static bool _sameNamedSession(
    ClinicalContinuitySessionContext left,
    ClinicalContinuitySessionContext right,
  ) {
    return left.tenantId == right.tenantId &&
        left.facilityId == right.facilityId &&
        left.staffId == right.staffId &&
        left.role == right.role &&
        left.deviceId == right.deviceId;
  }

  static bool _sameSessionInstance(
    ClinicalContinuitySessionContext left,
    ClinicalContinuitySessionContext right,
  ) {
    return _sameNamedSession(left, right) &&
        left.authenticatedAt.toUtc() == right.authenticatedAt.toUtc();
  }

  static bool _hasLocalGrantCoverage(
    VerifiedClinicalContinuitySet set,
    ClinicalContinuitySessionContext session,
    DateTime? trustedNow,
  ) {
    if (trustedNow == null || session.role.trim().isEmpty) return false;
    final now = trustedNow.toUtc();
    final required = set.packs
        .map((pack) => '${pack.locationType}/${pack.locationId}')
        .toSet();
    final authorized = set.localGrants
        .where(
          (grant) =>
              grant.staffId == session.staffId &&
              grant.deviceId == session.deviceId &&
              !now.isBefore(grant.validFrom.toUtc()) &&
              now.isBefore(grant.validUntil.toUtc()),
        )
        .map((grant) => '${grant.locationType}/${grant.locationId}')
        .toSet();
    return required.isNotEmpty && authorized.containsAll(required);
  }

  @override
  void dispose() {
    _disposed = true;
    _currentSet = null;
    _clearTrustedClock();
    _stopPeriodicRefresh();
    unawaited(_source.cancel());
    unawaited(_cache.close());
    super.dispose();
  }
}

class _UnavailableClinicalContinuitySource implements ClinicalContinuitySource {
  const _UnavailableClinicalContinuitySource();

  @override
  Future<ClinicalContinuityClockAssessment> assessClock() async =>
      const ClinicalContinuityClockAssessment(trusted: false, trustedNow: null);

  @override
  Future<void> cancel() async {}

  @override
  Future<ClinicalContinuitySessionContext?> currentSession() async => null;

  @override
  Future<ClinicalContinuitySourceSnapshot> fetchFacilitySet() {
    throw StateError('Clinical continuity source is not installed');
  }
}
