// lib/core/providers/websocket_provider.dart

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:vhhealth/core/services/websocket_service.dart';

/// Provider that bridges [WebSocketService] events into the widget tree.
///
/// Listens for "notification" and "appointment-status-changed" events and
/// exposes them so that [NotificationProvider] and appointment screens can
/// react in real time.
class WebSocketProvider extends ChangeNotifier {
  StreamSubscription<Map<String, dynamic>>? _subscription;

  /// The most recent "appointment-status-changed" event payload, or `null`.
  Map<String, dynamic>? _lastAppointmentEvent;
  Map<String, dynamic>? get lastAppointmentEvent => _lastAppointmentEvent;

  /// Pending in-app notifications received over WS (not yet consumed).
  final List<Map<String, dynamic>> _wsNotifications = [];
  List<Map<String, dynamic>> get wsNotifications =>
      List.unmodifiable(_wsNotifications);

  /// Start listening to the WebSocket stream.
  void listen() {
    _subscription?.cancel();
    _subscription = WebSocketService.instance.stream.listen(_onEvent);
  }

  void _onEvent(Map<String, dynamic> event) {
    final name = event['event'] as String?;
    if (name == null) return;

    switch (name) {
      case 'notification':
        final data = event['data'];
        if (data is Map<String, dynamic>) {
          _wsNotifications.add(data);
          notifyListeners();
        }
      case 'appointment-status-changed':
        _lastAppointmentEvent = event['data'] as Map<String, dynamic>?;
        notifyListeners();
      default:
        if (kDebugMode) {
          debugPrint('WebSocketProvider: unhandled event "$name"');
        }
    }
  }

  /// Clear consumed notifications (called after they are merged into
  /// [NotificationProvider]).
  void clearNotifications() {
    _wsNotifications.clear();
  }

  /// Clear the last appointment event after the screen has reacted.
  void clearAppointmentEvent() {
    _lastAppointmentEvent = null;
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }
}
