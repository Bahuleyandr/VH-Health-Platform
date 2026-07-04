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
  final List<Map<String, dynamic>> _notifications = [];
  final List<Map<String, dynamic>> _appointmentUpdates = [];
  Map<String, dynamic>? _latestQueueUpdate;
  bool _disposed = false;

  List<Map<String, dynamic>> get notifications =>
      List.unmodifiable(_notifications);
  List<Map<String, dynamic>> get appointmentUpdates =>
      List.unmodifiable(_appointmentUpdates);
  Map<String, dynamic>? get latestQueueUpdate => _latestQueueUpdate;
  bool get isConnected => _realtime?.isConnected ?? false;

  void bind(RealtimeProvider realtime) {
    if (identical(_realtime, realtime) && _subscriptions.isNotEmpty) return;

    _realtime?.removeListener(_handleRealtimeChanged);
    unawaited(_cancelSubscriptions());
    _realtime = realtime..addListener(_handleRealtimeChanged);

    _subscriptions
      ..clear()
      ..add(
        realtime
            .events('notification', broadcastChannel: false)
            .listen(_handleEvent),
      )
      ..add(
        realtime
            .events('appointment-status-changed', broadcastChannel: false)
            .listen(_handleEvent),
      )
      ..add(realtime.events('staff:appointments').listen(_handleEvent))
      ..add(realtime.events('queue-updates').listen(_handleEvent));

    unawaited(realtime.ensureConnected());
    scheduleMicrotask(_handleRealtimeChanged);
  }

  Future<void> _cancelSubscriptions() async {
    final subscriptions = List<StreamSubscription<RealtimeEvent>>.from(
      _subscriptions,
    );
    _subscriptions.clear();
    for (final subscription in subscriptions) {
      await subscription.cancel();
    }
  }

  void _handleRealtimeChanged() {
    if (!_disposed) notifyListeners();
  }

  void _handleEvent(RealtimeEvent event) {
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
    _realtime?.removeListener(_handleRealtimeChanged);
    unawaited(_cancelSubscriptions());
    super.dispose();
  }
}
