import 'dart:async';

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

  Future<void> _operations = Future<void>.value();
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

  Future<void> _enqueue(PatientRealtimeStart operation) {
    final next = _operations.then((_) => operation());
    _operations = next.catchError((Object _, StackTrace __) {});
    return next;
  }
}
