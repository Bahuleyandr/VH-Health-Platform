import 'dart:async';

import 'package:flutter/foundation.dart';

typedef PatientRealtimeStart = Future<void> Function();
typedef PatientRealtimeStop =
    Future<void> Function({required bool unsubscribe});

/// Serializes Patient realtime lifecycle work and fences it across logout.
///
/// A start request captures the current generation when it is queued. Logout
/// advances the generation synchronously, so an online/resume callback already
/// waiting in the queue cannot bind the departing identity afterwards.
class PatientRealtimeLifecycle {
  PatientRealtimeLifecycle();

  static final PatientRealtimeLifecycle instance = PatientRealtimeLifecycle();

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
  Future<void> completeTeardown(PatientRealtimeStart finalDisconnect) async {
    final teardownGeneration = _generation;
    try {
      await _enqueue(() async {
        try {
          await _stop?.call(unsubscribe: true);
        } finally {
          await finalDisconnect();
        }
      });
    } finally {
      if (_tearingDown && teardownGeneration == _generation) {
        _generation += 1;
        _tearingDown = false;
      }
    }
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
  }

  Future<void> _enqueue(PatientRealtimeStart operation) {
    final next = (_operations ?? Future<void>.value()).then((_) => operation());
    _operations = next.catchError((Object _, StackTrace __) {});
    return next;
  }
}
