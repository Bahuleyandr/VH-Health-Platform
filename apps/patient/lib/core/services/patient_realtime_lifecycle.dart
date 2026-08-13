import 'dart:async';

import 'package:flutter/foundation.dart';

typedef PatientRealtimeStart = Future<void> Function();
typedef PatientRealtimeStop =
    Future<void> Function({required bool unsubscribe});

/// What [PatientRealtimeLifecycle.completeTeardown] actually achieved.
///
/// Returned rather than swallowed so the caller can report the degraded case
/// instead of presenting an identical "signed out" result either way.
enum PatientRealtimeTeardownResult {
  /// The queued work drained and the final disconnect ran within the bound.
  completed,

  /// [PatientRealtimeLifecycle.stopTimeout] expired before the queued stop
  /// resolved. The final disconnect was still attempted, the queue tail was
  /// abandoned, and logout completed instead of hanging.
  timedOut,
}

/// Serializes Patient realtime lifecycle work and fences it across logout.
///
/// A start request captures the current generation when it is queued. Logout
/// advances the generation synchronously, so an online/resume callback already
/// waiting in the queue cannot bind the departing identity afterwards.
class PatientRealtimeLifecycle {
  PatientRealtimeLifecycle();

  static final PatientRealtimeLifecycle instance = PatientRealtimeLifecycle();

  /// Hard bound on the best-effort client-side realtime teardown.
  ///
  /// WHY BOUNDING THIS IS SAFE. The authoritative severance is SERVER-SIDE,
  /// not here: patient logout POSTs `/auth/logout`, which reaches
  /// `authService.logout` → `revokeAllUserTokens(..., reason: 'logout')` →
  /// `tokenBlacklist.js` ("R14: close the revoked identity's live
  /// WebSockets") → `wsServer.pushSessionRevoked` → `deliverUserLocal`, whose
  /// `isRevocation` branch CLOSES the identity's sockets server-side. The
  /// `_stop` awaited in [completeTeardown] is belt-and-braces LOCAL cleanup
  /// layered on top of that, so putting a ceiling on it cannot weaken the
  /// severance invariant.
  ///
  /// Leaving it unbounded, by contrast, is a real defect: a genuinely dead or
  /// black-holed socket means `LogoutService.logout()` never returns and the
  /// blocking "Signing out…" dialog spins forever, until the user force-quits
  /// — which reaches the SAME server-side outcome, only later, and with no
  /// telemetry at all.
  ///
  /// 4 seconds is chosen to match `LogoutService._networkCallTimeout`, the
  /// app's established "one short attempt" unit, so the whole logout keeps a
  /// predictable ceiling. A healthy client-side disconnect needs no network
  /// round trip and returns in milliseconds; the only reason this can take
  /// seconds is a wedged socket. 3s risks cutting a legitimately slow but
  /// progressing in-flight start on a poor mobile link, and 5s buys a further
  /// second of spinner with no extra success probability for a socket that is
  /// by construction black-holed.
  ///
  /// Mutable so tests can shrink it; [debugReset] restores the default.
  static Duration stopTimeout = const Duration(seconds: 4);

  /// Tail of the serialized operation queue, created lazily by [_enqueue].
  ///
  /// Deliberately NOT eagerly initialized. `Future._addListener` schedules an
  /// already-completed future's continuation on the zone that future was
  /// *created* in — not `Zone.current`. An eagerly-created tail therefore
  /// anchored this process-wide singleton's chain to whichever zone first
  /// touched it, and every later `.then` was scheduled back into that zone.
  /// Under `testWidgets` each body runs in its own FakeAsync zone that is torn
  /// down when the test ends, so from the second widget test onward the
  /// continuation was queued into a dead zone and never ran: [completeTeardown]
  /// — and with it `LogoutService.logout()` — never completed. Starting from
  /// null lets each fresh chain anchor in the zone that actually drives it.
  Future<void>? _operations;
  Object? _owner;
  PatientRealtimeStart? _start;
  PatientRealtimeStop? _stop;
  int _generation = 0;
  bool _tearingDown = false;

  bool get isTearingDown => _tearingDown;

  void attach({
    required Object owner,
    required PatientRealtimeStart start,
    required PatientRealtimeStop stop,
  }) {
    if (_owner != null && !identical(_owner, owner)) {
      throw StateError('Patient realtime lifecycle already has an owner');
    }
    _owner = owner;
    _start = start;
    _stop = stop;
  }

  void detach(Object owner) {
    if (!identical(_owner, owner)) return;
    _generation += 1;
    _owner = null;
    _start = null;
    _stop = null;
  }

  Future<void> queueStart() {
    final requestedGeneration = _generation;
    return _enqueue(() async {
      if (_tearingDown || requestedGeneration != _generation) return;
      await _start?.call();
    });
  }

  Future<void> queueStop({bool unsubscribe = false}) {
    return _enqueue(() async {
      await _stop?.call(unsubscribe: unsubscribe);
    });
  }

  /// Enters logout fencing synchronously, before any socket disconnect awaits.
  void beginTeardown() {
    _generation += 1;
    _tearingDown = true;
  }

  /// Drains earlier work, retires personal subscriptions, and performs the
  /// caller's final disconnect before starts are admitted for a future login.
  ///
  /// Bounded by [stopTimeout]. On expiry the final disconnect is still
  /// ATTEMPTED — it is merely no longer waited on behind a dead socket — and
  /// [PatientRealtimeTeardownResult.timedOut] is returned so the caller can
  /// record it. Nothing here is swallowed.
  Future<PatientRealtimeTeardownResult> completeTeardown(
    PatientRealtimeStart finalDisconnect,
  ) async {
    final teardownGeneration = _generation;
    // The final disconnect is attempted exactly once, whether the queued
    // teardown reaches it or the bound below expires first. Without this
    // one-shot claim an abandoned drain that later unwedges would disconnect
    // a second time, after a new login may already have reconnected.
    var finalDisconnectClaimed = false;
    Future<void> attemptFinalDisconnect() async {
      if (finalDisconnectClaimed) return;
      finalDisconnectClaimed = true;
      await finalDisconnect();
    }

    var timedOut = false;
    try {
      final drain = _enqueue(() async {
        try {
          final stopping = _stop?.call(unsubscribe: true);
          if (stopping != null) await stopping;
        } finally {
          await attemptFinalDisconnect();
        }
      });
      await drain.timeout(
        stopTimeout,
        onTimeout: () async {
          timedOut = true;
          // Abandon the wedged chain. `_operations` still points at the drain
          // that never resolved; leaving it there would make the NEXT login's
          // queueStart wait behind the very same dead socket, turning a
          // bounded logout into an unbounded login. Null rather than a
          // completed future so the next chain anchors in the zone that
          // actually drives it — see the [_operations] docstring.
          _operations = null;
          await attemptFinalDisconnect();
        },
      );
    } finally {
      if (_tearingDown && teardownGeneration == _generation) {
        _generation += 1;
        _tearingDown = false;
      }
    }
    return timedOut
        ? PatientRealtimeTeardownResult.timedOut
        : PatientRealtimeTeardownResult.completed;
  }

  /// Clears every piece of cross-test state on the shared [instance],
  /// including the queued-operations tail whose zone would otherwise outlive
  /// the test that created it. Call from `setUp`/`tearDown` in any suite that
  /// drives logout more than once.
  @visibleForTesting
  void debugReset() {
    _operations = null;
    _owner = null;
    _start = null;
    _stop = null;
    _generation = 0;
    _tearingDown = false;
    // Also restore the process-wide bound, so a suite that shrinks it to keep
    // a hang test fast cannot leak that value into unrelated suites.
    stopTimeout = const Duration(seconds: 4);
  }

  Future<void> _enqueue(PatientRealtimeStart operation) {
    final next = (_operations ?? Future<void>.value()).then((_) => operation());
    _operations = next.catchError((Object _, StackTrace _) {});
    return next;
  }
}
