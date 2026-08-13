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
  /// resolved. The final disconnect was still STARTED — deliberately without
  /// awaiting it, see [PatientRealtimeLifecycle.completeTeardown] — and logout
  /// completed instead of hanging.
  timedOut,

  /// The drain threw. Distinct from [timedOut] because reporting a thrown
  /// teardown as a timeout would be a lie, and reporting it as [completed]
  /// would be the silent degradation the bound exists to make visible.
  ///
  /// [PatientRealtimeLifecycle.completeTeardown] returns this rather than
  /// rethrowing, so the caller can never lose the result to its own `catch`.
  failed,
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
  /// This is the SOCKET-shaped ceiling, and `LogoutService` uses it twice: for
  /// its step-1 realtime disconnect (which runs before every local PHI wipe and
  /// calls the same singleton method) and for the teardown here. Both are the
  /// same hazard, so both take the same unit and the same knob.
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

  /// The current lifecycle era. Advanced by [beginTeardown], by the release at
  /// the end of [completeTeardown], and by [detach].
  ///
  /// Exposed so the OWNER of `_stop` can re-check it partway through its own
  /// teardown: `_stop` touches the process-wide `RealtimeClient` singleton, and
  /// a `_stop` slow enough to outlive [stopTimeout] is abandoned by logout while
  /// still in flight. Comparing the generation before the singleton-level
  /// disconnect is what stops that straggler from disconnecting a session a
  /// LATER login has already established.
  int get generation => _generation;

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
    final requestedGeneration = _generation;
    return _enqueue(() async {
      // Same fence as [queueStart], for the same reason in the other
      // direction: a pause/background stop queued before a logout must not
      // reach the shared realtime singleton after a NEW session has bound it.
      // The teardown's own `_stop(unsubscribe: true)` is strictly stronger, so
      // dropping a stale one loses nothing.
      if (requestedGeneration != _generation) return;
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
  /// STARTED — but deliberately NOT awaited, see below — and
  /// [PatientRealtimeTeardownResult.timedOut] is returned so the caller can
  /// record it. Nothing here is swallowed, and nothing here can throw: a drain
  /// error becomes [PatientRealtimeTeardownResult.failed] so the caller cannot
  /// lose the result to its own `catch`.
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
    var failed = false;
    try {
      final drain = _enqueue(() async {
        // GENERATION FENCE ON THE DRAIN, mirroring [queueStart].
        //
        // Without it this closure is the one path that reaches `_stop` with no
        // era check at all. A drain queued behind slow earlier work can arrive
        // at the front of the queue only AFTER the bound below expired and the
        // fence was released — by which time a new login may own the realtime
        // fabric. Invoking `_stop(unsubscribe: true)` then would retire that
        // NEW session's patient state, unsubscribe its channels and disconnect
        // its socket, with no visible error anywhere.
        if (_generation != teardownGeneration) return;
        try {
          final stopping = _stop?.call(unsubscribe: true);
          if (stopping != null) await stopping;
        } finally {
          await attemptFinalDisconnect();
        }
      });
      await drain.timeout(
        stopTimeout,
        onTimeout: () {
          timedOut = true;
          // NOT awaited — and that is the whole point of this branch.
          //
          // `finalDisconnect` resolves to `RealtimeClient.instance.disconnect`,
          // the SAME singleton method `_stop` reaches through
          // `_stopRealtime` → `RealtimeProvider.disconnect`. On the motivating
          // case — a genuinely dead / black-holed socket — the first call is
          // parked inside `await _channel?.sink.close(...)` and has not yet
          // reached `_channel = null`, so a second call re-awaits that same
          // pending close. Awaiting the escape hatch therefore re-enters the
          // exact wedge the bound was added to escape, and `completeTeardown`
          // never returns. Start it (the disconnect must still be ATTEMPTED)
          // and let logout proceed.
          unawaited(
            attemptFinalDisconnect().catchError((Object error, StackTrace _) {
              debugPrint(
                'PatientRealtimeLifecycle: the post-timeout disconnect failed: '
                '$error',
              );
            }),
          );
          // The queue tail is deliberately KEPT. An earlier cut nulled
          // `_operations` here so the next login would not wait behind the
          // dead socket — but nothing on any login path awaits [queueStart]
          // (every call site in `main.dart` and `app_router.dart` wraps it in
          // `unawaited`), so that bought nothing, and it restored concurrency:
          // a new login's start would run alongside a still-in-flight `_stop`
          // whose late effects tear the new session down. Keeping the tail
          // keeps the queue serialized — a start after an abandoned teardown
          // runs as soon as the straggler settles, and never before it.
        },
      );
    } catch (error) {
      // A thrown drain must not escape: the caller's `catch` would swallow the
      // return value along with it and the timeout would go unreported.
      failed = true;
      debugPrint('PatientRealtimeLifecycle: the teardown drain threw: $error');
    } finally {
      if (_tearingDown && teardownGeneration == _generation) {
        _generation += 1;
        _tearingDown = false;
      }
    }
    if (timedOut) return PatientRealtimeTeardownResult.timedOut;
    if (failed) return PatientRealtimeTeardownResult.failed;
    return PatientRealtimeTeardownResult.completed;
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
