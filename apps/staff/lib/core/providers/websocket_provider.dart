import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/vhhealth_core.dart'
    show RealtimeEvent, RealtimeProvider;

/// Compatibility provider for the older dashboard/notifications widgets.
///
/// The app-level socket lifecycle is owned by [RealtimeProvider]; this class
/// only adapts the core streams into the UI lists those widgets already read.
class WebSocketProvider extends ChangeNotifier {
  static const int _maxNotifications = 50;

  RealtimeProvider? _realtime;
  final List<StreamSubscription<RealtimeEvent>> _subscriptions = [];
  final StreamController<RealtimeEvent> _codeBlueEvents =
      StreamController<RealtimeEvent>.broadcast();
  final List<Map<String, dynamic>> _notifications = [];
  final List<Map<String, dynamic>> _appointmentUpdates = [];
  Map<String, dynamic>? _latestQueueUpdate;
  Future<void> _cancellationTail = Future<void>.value();
  int _sessionGeneration = 0;
  bool _sessionActive = false;
  bool _disposed = false;

  List<Map<String, dynamic>> get notifications =>
      List.unmodifiable(_notifications);
  List<Map<String, dynamic>> get appointmentUpdates =>
      List.unmodifiable(_appointmentUpdates);
  Map<String, dynamic>? get latestQueueUpdate => _latestQueueUpdate;
  Stream<RealtimeEvent> get codeBlueEvents => _codeBlueEvents.stream;
  bool get hasAuthenticatedSession => _sessionActive;
  bool get isConnected => _sessionActive && (_realtime?.isConnected ?? false);

  void bind(RealtimeProvider realtime) {
    if (_disposed) return;
    if (identical(_realtime, realtime) &&
        (_subscriptions.isNotEmpty || !_sessionActive)) {
      return;
    }

    _realtime?.removeListener(_handleRealtimeChanged);
    unawaited(_invalidateSubscriptions());
    _realtime = realtime..addListener(_handleRealtimeChanged);

    if (_sessionActive) {
      _attachSubscriptions();
    }
    scheduleMicrotask(_handleRealtimeChanged);
  }

  /// Starts a new authenticated UI session after login.
  ///
  /// The router calls this only after it has verified a persisted JWT. A new
  /// generation is created before listeners are attached, so callbacks queued
  /// by a previous account can never populate this account's state.
  Future<void> beginAuthenticatedSession() async {
    if (_disposed) return;
    if (_sessionActive && _subscriptions.isNotEmpty) return;

    _sessionActive = true;
    unawaited(_invalidateSubscriptions());
    _attachSubscriptions();
    notifyListeners();
  }

  /// Ends the current authenticated UI session.
  ///
  /// Generation invalidation and state clearing happen synchronously before
  /// subscription cancellation is awaited. Even a callback already queued by
  /// the old stream therefore sees a stale generation and is ignored.
  Future<void> endAuthenticatedSession() async {
    if (_disposed) return;

    _sessionActive = false;
    final cancellation = _invalidateSubscriptions();
    _notifications.clear();
    _appointmentUpdates.clear();
    _latestQueueUpdate = null;
    notifyListeners();
    await cancellation;
  }

  void _attachSubscriptions() {
    final realtime = _realtime;
    if (realtime == null || !_sessionActive || _disposed) return;
    final generation = _sessionGeneration;
    _subscriptions
      ..add(
        realtime
            .events('notification', broadcastChannel: false)
            .listen((event) => _handleEvent(event, generation)),
      )
      ..add(
        realtime
            .events('appointment-status-changed', broadcastChannel: false)
            .listen((event) => _handleEvent(event, generation)),
      )
      ..add(
        realtime
            .events('staff:appointments')
            .listen((event) => _handleEvent(event, generation)),
      )
      ..add(
        realtime
            .events('queue-updates')
            .listen((event) => _handleEvent(event, generation)),
      )
      ..add(
        realtime
            .events('staff:code-blue')
            .listen((event) => _handleEvent(event, generation)),
      );

    unawaited(realtime.ensureConnected());
  }

  Future<void> _invalidateSubscriptions() {
    _sessionGeneration += 1;
    final subscriptions = List<StreamSubscription<RealtimeEvent>>.from(
      _subscriptions,
    );
    _subscriptions.clear();
    final cancellation = _cancelAfter(_cancellationTail, subscriptions);
    _cancellationTail = cancellation;
    return cancellation;
  }

  static Future<void> _cancelAfter(
    Future<void> previous,
    List<StreamSubscription<RealtimeEvent>> subscriptions,
  ) async {
    try {
      await previous;
    } catch (_) {}
    for (final subscription in subscriptions) {
      try {
        await subscription.cancel();
      } catch (error) {
        debugPrint('Realtime adapter subscription cleanup failed: $error');
      }
    }
  }

  void _handleRealtimeChanged() {
    if (!_disposed) notifyListeners();
  }

  void _handleEvent(RealtimeEvent event, int generation) {
    if (_disposed || !_sessionActive || generation != _sessionGeneration) {
      return;
    }
    switch (event.channel) {
      case 'notification':
        _insertNotification(event.data);
        notifyListeners();

      case 'appointment-status-changed':
      case 'staff:appointments':
        _appointmentUpdates.insert(0, event.data);
        notifyListeners();

      case 'queue-updates':
        _latestQueueUpdate = event.data;
        notifyListeners();

      case 'staff:code-blue':
        _codeBlueEvents.add(event);
    }
  }

  void _insertNotification(Map<String, dynamic> notification) {
    _notifications.insert(0, notification);
    if (_notifications.length > _maxNotifications) {
      _notifications.removeLast();
    }
  }

  void clearNotifications() {
    _notifications.clear();
    notifyListeners();
  }

  void clearAppointmentUpdates() {
    _appointmentUpdates.clear();
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _sessionActive = false;
    _realtime?.removeListener(_handleRealtimeChanged);
    unawaited(_invalidateSubscriptions());
    unawaited(_codeBlueEvents.close());
    super.dispose();
  }
}
