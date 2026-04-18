import 'dart:async';
import 'package:flutter/foundation.dart';
import '../services/websocket_service.dart';

class WebSocketProvider extends ChangeNotifier {
  final WebSocketService _ws = WebSocketService.instance;
  StreamSubscription<Map<String, dynamic>>? _subscription;

  static const int _maxNotifications = 50;

  final List<Map<String, dynamic>> _notifications = [];
  final List<Map<String, dynamic>> _appointmentUpdates = [];
  Map<String, dynamic>? _latestQueueUpdate;

  List<Map<String, dynamic>> get notifications =>
      List.unmodifiable(_notifications);
  List<Map<String, dynamic>> get appointmentUpdates =>
      List.unmodifiable(_appointmentUpdates);
  Map<String, dynamic>? get latestQueueUpdate => _latestQueueUpdate;
  bool get isConnected => _ws.isConnected;

  void init() {
    _ws.connect(channels: [
      'appointment-updates',
      'queue-updates',
    ]);

    _subscription = _ws.stream.listen(_handleEvent);
  }

  void _handleEvent(Map<String, dynamic> message) {
    final event = message['event']?.toString() ?? '';

    switch (event) {
      case 'notification':
        _notifications.insert(0, message['data'] ?? message);
        if (_notifications.length > _maxNotifications) {
          _notifications.removeLast();
        }
        notifyListeners();

      case 'appointment-status-changed':
        _appointmentUpdates.insert(0, message['data'] ?? message);
        notifyListeners();

      case 'queue-updates':
        _latestQueueUpdate = message['data'] ?? message;
        notifyListeners();

      case 'connected':
        debugPrint('WebSocket: Server confirmed connection');
        notifyListeners();

      case 'subscribed':
        debugPrint('WebSocket: Subscribed to ${message['channel']}');
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
    _subscription?.cancel();
    _ws.disconnect();
    super.dispose();
  }
}
